import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";

import { SCHEMA_SQL } from "../db/schema.js";
import { recoverInProgressOrphans, recoverStuckAutoStages } from "./jobs.js";

// ---- Test doubles ---------------------------------------------------------

type WsEvent = { type: string; payload: unknown };

interface FakeWs {
  broadcast: (type: string, payload: unknown) => void;
  events: WsEvent[];
}

function createFakeWs(): FakeWs {
  const events: WsEvent[] = [];
  return {
    events,
    broadcast: (type, payload) => {
      events.push({ type, payload });
    },
  };
}

// ---- Fixtures -------------------------------------------------------------

function createInMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  // Apply migrations that later schema versions rely on
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "last_heartbeat_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN last_heartbeat_at INTEGER");
  }
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("agent-1", "tester-jobs", "claude", "working", now, now);
  db.prepare("UPDATE agents SET current_task_id = NULL WHERE id = 'agent-1'").run();
  return db;
}

function insertTask(
  db: DatabaseSync,
  overrides: {
    id: string;
    status: string;
    assigned_agent_id?: string | null;
    updated_at?: number;
    last_heartbeat_at?: number | null;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, task_size, created_at, updated_at, last_heartbeat_at)
     VALUES (?, ?, ?, ?, 'small', ?, ?, ?)`,
  ).run(
    overrides.id,
    `task-${overrides.id}`,
    overrides.status,
    overrides.assigned_agent_id ?? null,
    now,
    overrides.updated_at ?? now,
    overrides.last_heartbeat_at ?? null,
  );
}

// Pre-grace startedAt so the auto-stage recovery function processes the rows
// immediately. "10 minutes ago" is well past the 2-minute startup grace.
const PAST_START = Date.now() - 10 * 60 * 1000;

// ---- recoverInProgressOrphans --------------------------------------------

describe("recoverInProgressOrphans", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it("keeps in_progress orphans at in_progress instead of bouncing to inbox", () => {
    // Previously orphan recovery sent in_progress tasks back to inbox so
    // auto-dispatcher would restart the whole workflow (refinement →
    // implementation → review…). That silently undid any pr_review /
    // qa_testing / ci_check rework loop. The fixture agent is created
    // with status='working' (see createInMemoryDb), so spawnAgent is NOT
    // triggered here — instead the task stays parked at in_progress and
    // the assigned agent is released to idle for the next tick.
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    const ws = createFakeWs();

    recoverInProgressOrphans(db, ws as never, undefined, new Set());

    const row = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string };
    // Must NOT regress past in_progress.
    assert.notEqual(row.status, "inbox");
    assert.equal(row.status, "in_progress");

    const agent = db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'agent-1'").get() as {
      status: string;
      current_task_id: string | null;
    };
    assert.equal(agent.status, "idle");

    // Broadcast should describe the agent release, but no inbox
    // task_update should have been emitted.
    assert.ok(
      ws.events.some((e) => e.type === "agent_status"),
      "expected agent_status broadcast on agent release",
    );
    assert.ok(
      !ws.events.some(
        (e) => e.type === "task_update" && (e.payload as { status?: string })?.status === "inbox",
      ),
      "task must not be broadcast as returned to inbox",
    );
  });

  it("leaves tasks alone when they have an active process", () => {
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    const ws = createFakeWs();

    recoverInProgressOrphans(db, ws as never, undefined, new Set(["t1"]));

    const row = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string };
    assert.equal(row.status, "in_progress");
  });

  it("still bounces refinement-without-plan orphans back to inbox", () => {
    // Refinement tasks that never produced a plan are a genuine dead
    // start; the auto-dispatcher needs a fresh run, which only happens
    // from inbox. This path must keep working.
    insertTask(db, { id: "t2", status: "refinement", assigned_agent_id: "agent-1" });
    const ws = createFakeWs();

    recoverInProgressOrphans(db, ws as never, undefined, new Set());

    const row = db.prepare("SELECT status FROM tasks WHERE id = 't2'").get() as { status: string };
    assert.equal(row.status, "inbox");
    assert.ok(
      ws.events.some(
        (e) => e.type === "task_update" && (e.payload as { status?: string })?.status === "inbox",
      ),
    );
  });
});

// ---- recoverStuckAutoStages ----------------------------------------------

describe("recoverStuckAutoStages", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it("promotes a stuck pr_review task to human_review", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    insertTask(db, {
      id: "stuck",
      status: "pr_review",
      assigned_agent_id: "agent-1",
      last_heartbeat_at: elevenMinutesAgo,
    });
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, undefined, new Set(), PAST_START);

    const row = db.prepare("SELECT status FROM tasks WHERE id = 'stuck'").get() as { status: string };
    assert.equal(row.status, "human_review");
    assert.ok(ws.events.some((e) => e.type === "task_update"));
  });

  it("promotes stuck qa_testing / test_generation / ci_check tasks", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    for (const [id, status] of [
      ["qa", "qa_testing"],
      ["tg", "test_generation"],
      ["pd", "ci_check"],
    ] as const) {
      insertTask(db, { id, status, assigned_agent_id: "agent-1", last_heartbeat_at: elevenMinutesAgo });
    }
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, undefined, new Set(), PAST_START);

    const rows = db.prepare("SELECT id, status FROM tasks WHERE id IN ('qa','tg','pd')").all() as Array<{
      id: string;
      status: string;
    }>;
    for (const r of rows) assert.equal(r.status, "human_review", `task ${r.id} should be human_review`);
  });

  it("skips auto-stage tasks with a fresh heartbeat", () => {
    const oneMinuteAgo = Date.now() - 60 * 1000;
    insertTask(db, {
      id: "fresh",
      status: "pr_review",
      assigned_agent_id: "agent-1",
      last_heartbeat_at: oneMinuteAgo,
    });
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, undefined, new Set(), PAST_START);

    const row = db.prepare("SELECT status FROM tasks WHERE id = 'fresh'").get() as { status: string };
    assert.equal(row.status, "pr_review");
  });

  it("falls back to updated_at when last_heartbeat_at is null", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    insertTask(db, {
      id: "legacy",
      status: "pr_review",
      assigned_agent_id: "agent-1",
      updated_at: elevenMinutesAgo,
      last_heartbeat_at: null,
    });
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, undefined, new Set(), PAST_START);

    const row = db.prepare("SELECT status FROM tasks WHERE id = 'legacy'").get() as { status: string };
    assert.equal(row.status, "human_review");
  });

  it("respects the startup grace window", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    insertTask(db, {
      id: "stuck",
      status: "pr_review",
      last_heartbeat_at: elevenMinutesAgo,
    });
    const ws = createFakeWs();

    // Server just started (now) — within the 2-minute grace window
    recoverStuckAutoStages(db, ws as never, undefined, new Set(), Date.now());

    const row = db.prepare("SELECT status FROM tasks WHERE id = 'stuck'").get() as { status: string };
    assert.equal(row.status, "pr_review", "should not promote during grace window");
    assert.equal(ws.events.length, 0);
  });

  it("does not promote when a live process owns the task", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    insertTask(db, {
      id: "alive",
      status: "pr_review",
      assigned_agent_id: "agent-1",
      last_heartbeat_at: elevenMinutesAgo,
    });
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, undefined, new Set(["alive"]), PAST_START);

    const row = db.prepare("SELECT status FROM tasks WHERE id = 'alive'").get() as { status: string };
    assert.equal(row.status, "pr_review");
  });

  it("ignores tasks in non-auto stages (inbox, done, etc.)", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    insertTask(db, { id: "inbox-old", status: "inbox", updated_at: elevenMinutesAgo });
    insertTask(db, { id: "done-old", status: "done", updated_at: elevenMinutesAgo });
    insertTask(db, { id: "human-old", status: "human_review", updated_at: elevenMinutesAgo });
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, undefined, new Set(), PAST_START);

    const rows = db
      .prepare("SELECT id, status FROM tasks WHERE id IN ('inbox-old','done-old','human-old')")
      .all() as Array<{ id: string; status: string }>;
    assert.equal(rows.find((r) => r.id === "inbox-old")?.status, "inbox");
    assert.equal(rows.find((r) => r.id === "done-old")?.status, "done");
    assert.equal(rows.find((r) => r.id === "human-old")?.status, "human_review");
  });

  it("writes a system log entry explaining the promotion", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    insertTask(db, {
      id: "stuck",
      status: "pr_review",
      assigned_agent_id: "agent-1",
      last_heartbeat_at: elevenMinutesAgo,
    });
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, undefined, new Set(), PAST_START);

    const log = db
      .prepare("SELECT message FROM task_logs WHERE task_id = 'stuck' AND kind = 'system' ORDER BY id DESC LIMIT 1")
      .get() as { message: string };
    assert.match(log.message, /promoted to human_review/);
    assert.match(log.message, /pr_review/);
  });
});
