import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";

import { SCHEMA_SQL } from "../db/schema.js";
import {
  __resetPendingOrphanRespawnsForTests,
  recoverInProgressOrphans,
  recoverStuckAutoStages,
} from "./jobs.js";
import { SpawnPreflightError, createHookFailureFromCommands } from "../spawner/spawn-failures.js";

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
    started_at?: number | null;
    auto_respawn_count?: number;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, task_size, created_at, updated_at, last_heartbeat_at, started_at, auto_respawn_count)
     VALUES (?, ?, ?, ?, 'small', ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id,
    `task-${overrides.id}`,
    overrides.status,
    overrides.assigned_agent_id ?? null,
    now,
    overrides.updated_at ?? now,
    overrides.last_heartbeat_at ?? null,
    overrides.started_at ?? null,
    overrides.auto_respawn_count ?? 0,
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
    __resetPendingOrphanRespawnsForTests();
    db.close();
  });

  it("keeps in_progress orphans at in_progress instead of bouncing to inbox", () => {
    // Previously orphan recovery sent in_progress tasks back to inbox so
    // auto-dispatcher would restart the whole workflow (refinement →
    // implementation → review…). That silently undid any pr_review /
    // qa_testing rework loop. The fixture agent is created
    // with status='working' (see createInMemoryDb), so spawnAgent is NOT
    // triggered here — instead the task stays parked at in_progress and
    // the assigned agent is released to idle for the next tick.
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    const ws = createFakeWs();

    recoverInProgressOrphans(db, ws as never, new Set());

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

    recoverInProgressOrphans(db, ws as never, new Set(["t1"]));

    const row = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string };
    assert.equal(row.status, "in_progress");
  });

  it("auto-respawns a parked in_progress task when the agent is idle and budget allows", () => {
    // Simulate a crash: task is in_progress, agent was released to idle
    // by a previous orphan-recovery tick (or was never marked working
    // because the process died during spawn).
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();

    const spawnCalls: Array<{ taskId: string; agentId: string; autoRespawnCount: number }> = [];
    const fakeSpawn = ((_db: DatabaseSync, _ws: unknown, agent: { id: string }, task: { id: string; auto_respawn_count: number }) => {
      spawnCalls.push({ taskId: task.id, agentId: agent.id, autoRespawnCount: task.auto_respawn_count });
      return Promise.resolve({ pid: 12345 });
    }) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });

    assert.equal(spawnCalls.length, 1, "spawnAgent should be called exactly once");
    assert.equal(spawnCalls[0].taskId, "t1");
    assert.equal(spawnCalls[0].agentId, "agent-1");
    assert.equal(spawnCalls[0].autoRespawnCount, 1, "freshly-incremented count passed to spawn");

    const row = db.prepare("SELECT status, auto_respawn_count FROM tasks WHERE id = 't1'").get() as {
      status: string;
      auto_respawn_count: number;
    };
    assert.equal(row.status, "in_progress");
    assert.equal(row.auto_respawn_count, 1);

    const log = db
      .prepare("SELECT message FROM task_logs WHERE task_id = 't1' ORDER BY id DESC LIMIT 1")
      .get() as { message: string };
    assert.match(log.message, /auto-respawn attempt 1\/3/);
  });

  it("stops auto-respawning once the budget is exhausted", () => {
    insertTask(db, {
      id: "t1",
      status: "in_progress",
      assigned_agent_id: "agent-1",
      auto_respawn_count: 3,
    });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();

    let spawnCalls = 0;
    const fakeSpawn = (() => {
      spawnCalls += 1;
      return Promise.resolve({ pid: 1 });
    }) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });

    assert.equal(spawnCalls, 0, "must not spawn after budget exhausted");

    const row = db.prepare("SELECT auto_respawn_count FROM tasks WHERE id = 't1'").get() as {
      auto_respawn_count: number;
    };
    assert.equal(row.auto_respawn_count, 3, "counter stays at max");

    const log = db
      .prepare("SELECT message FROM task_logs WHERE task_id = 't1' ORDER BY id DESC LIMIT 1")
      .get() as { message: string };
    assert.match(log.message, /budget exhausted/i);
    assert.match(log.message, /3\/3/);
  });

  it("does not re-log the park message on every tick once budget is exhausted", () => {
    // Regression for: "Orphan recovery: parked at in_progress. Auto-respawn
    // budget exhausted (3/3)" was being re-emitted every 60s even after the
    // task was already parked, spamming the log.
    insertTask(db, {
      id: "t1",
      status: "in_progress",
      assigned_agent_id: "agent-1",
      auto_respawn_count: 3,
    });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();
    const fakeSpawn = (() => Promise.resolve({ pid: 1 })) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });
    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });
    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });

    const parkLogs = db
      .prepare(
        "SELECT COUNT(*) AS n FROM task_logs WHERE task_id = 't1' AND kind = 'system' AND message LIKE 'Orphan recovery: parked at in_progress%'",
      )
      .get() as { n: number };
    assert.equal(parkLogs.n, 1, "park message should only be logged once across repeated ticks");
  });

  it("skips auto-respawn when the task has no assigned agent", () => {
    // Without an assigned agent the recovery path has nothing to drive, so
    // it parks quietly without incrementing the counter.
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: null });
    const ws = createFakeWs();

    let spawnCalls = 0;
    const fakeSpawn = (() => {
      spawnCalls += 1;
      return Promise.resolve({ pid: 1 });
    }) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });

    assert.equal(spawnCalls, 0);
    const row = db.prepare("SELECT auto_respawn_count FROM tasks WHERE id = 't1'").get() as {
      auto_respawn_count: number;
    };
    assert.equal(row.auto_respawn_count, 0, "no increment when respawn skipped");
  });

  it("moves the task to human_review when auto-respawn hits a non-retryable before_run failure", async () => {
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();

    const fakeSpawn = (() => Promise.reject(
      createHookFailureFromCommands(["pnpm install"]),
    )) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });
    await Promise.resolve();

    const row = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string };
    assert.equal(row.status, "human_review");

    const logs = db.prepare("SELECT message FROM task_logs WHERE task_id = 't1' ORDER BY id ASC").all() as Array<{
      message: string;
    }>;
    assert.ok(logs.some((log) => /Orphan recovery auto-respawn: before_run failed: pnpm install/.test(log.message)));
  });

  it("skips auto-respawn when assigned agent has a non-implementer role (code_reviewer)", () => {
    // Regression: after pr_review → in_progress rework, assigned_agent_id
    // could point at the reviewer agent. Orphan recovery must not respawn
    // a code_reviewer as an implementer.
    const now = Date.now();
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("reviewer-1", "Reviewer", "claude", "code_reviewer", "idle", now, now);
    insertTask(db, { id: "t-rework", status: "in_progress", assigned_agent_id: "reviewer-1" });
    const ws = createFakeWs();

    let spawnCalls = 0;
    const fakeSpawn = (() => {
      spawnCalls += 1;
      return Promise.resolve({ pid: 1 });
    }) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });

    assert.equal(spawnCalls, 0, "must not respawn a code_reviewer as implementer");
    const row = db.prepare("SELECT status, auto_respawn_count FROM tasks WHERE id = 't-rework'").get() as {
      status: string;
      auto_respawn_count: number;
    };
    assert.equal(row.status, "in_progress");
    assert.equal(row.auto_respawn_count, 0, "counter should not increment on skip");

    const log = db
      .prepare("SELECT message FROM task_logs WHERE task_id = 't-rework' ORDER BY id DESC LIMIT 1")
      .get() as { message: string };
    assert.match(log.message, /non-implementer role "code_reviewer"/);
  });

  it("skips auto-respawn when assigned agent has a non-implementer role (security_reviewer)", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("sec-reviewer-1", "SecReviewer", "claude", "security_reviewer", "idle", now, now);
    insertTask(db, { id: "t-sec", status: "in_progress", assigned_agent_id: "sec-reviewer-1" });
    const ws = createFakeWs();

    let spawnCalls = 0;
    const fakeSpawn = (() => {
      spawnCalls += 1;
      return Promise.resolve({ pid: 1 });
    }) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });

    assert.equal(spawnCalls, 0, "must not respawn a security_reviewer as implementer");
  });

  it("reassigns orphan recovery to an idle implementer when assigned agent is a reviewer", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("reviewer-1", "Reviewer", "claude", "code_reviewer", "idle", now, now);
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("impl-1", "Implementer", "codex", "lead_engineer", "idle", now, now);
    insertTask(db, { id: "t-reassign", status: "in_progress", assigned_agent_id: "reviewer-1" });
    const ws = createFakeWs();

    const spawnCalls: Array<{ agentId: string }> = [];
    const fakeSpawn = ((_db: DatabaseSync, _ws: unknown, agent: { id: string }) => {
      spawnCalls.push({ agentId: agent.id });
      return Promise.resolve({ pid: 1 });
    }) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });

    assert.equal(spawnCalls.length, 1, "must auto-respawn with a replacement implementer");
    assert.equal(spawnCalls[0].agentId, "impl-1");
  });

  it("allows auto-respawn when assigned agent has an implementer role (lead_engineer)", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("impl-1", "Implementer", "claude", "lead_engineer", "idle", now, now);
    insertTask(db, { id: "t-impl", status: "in_progress", assigned_agent_id: "impl-1" });
    const ws = createFakeWs();

    const spawnCalls: Array<{ agentId: string }> = [];
    const fakeSpawn = ((_db: DatabaseSync, _ws: unknown, agent: { id: string }) => {
      spawnCalls.push({ agentId: agent.id });
      return Promise.resolve({ pid: 1 });
    }) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), { spawnAgent: fakeSpawn, maxAutoRespawn: 3 });

    assert.equal(spawnCalls.length, 1, "should respawn lead_engineer as implementer");
    assert.equal(spawnCalls[0].agentId, "impl-1");
  });

  it("still bounces refinement-without-plan orphans back to inbox", () => {
    // Refinement tasks that never produced a plan are a genuine dead
    // start; the auto-dispatcher needs a fresh run, which only happens
    // from inbox. This path must keep working.
    insertTask(db, { id: "t2", status: "refinement", assigned_agent_id: "agent-1" });
    const ws = createFakeWs();

    recoverInProgressOrphans(db, ws as never, new Set());

    const row = db.prepare("SELECT status FROM tasks WHERE id = 't2'").get() as { status: string };
    assert.equal(row.status, "inbox");
    assert.ok(
      ws.events.some(
        (e) => e.type === "task_update" && (e.payload as { status?: string })?.status === "inbox",
      ),
    );
  });

  it("skips tasks in pendingSpawns (preflight: Explore Phase / before_run)", () => {
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();

    let spawnCalls = 0;
    const fakeSpawn = (() => {
      spawnCalls += 1;
      return Promise.resolve({ pid: 1 });
    }) as never;

    const pending = new Set(["t1"]);
    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
      pending,
    });

    assert.equal(spawnCalls, 0, "must not respawn a task in preflight");
    const row = db.prepare("SELECT auto_respawn_count FROM tasks WHERE id = 't1'").get() as {
      auto_respawn_count: number;
    };
    assert.equal(row.auto_respawn_count, 0, "counter must not increment during preflight");

    const logs = db.prepare("SELECT COUNT(*) AS n FROM task_logs WHERE task_id = 't1'").get() as { n: number };
    assert.equal(logs.n, 0, "no orphan-recovery log should be emitted for pending tasks");
  });

  it("does not consume auto-respawn budget across multiple ticks during preflight", () => {
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();

    let spawnCalls = 0;
    const fakeSpawn = (() => {
      spawnCalls += 1;
      return Promise.resolve({ pid: 1 });
    }) as never;

    const pending = new Set(["t1"]);

    // Simulate 5 orphan-recovery ticks while task is in preflight
    for (let i = 0; i < 5; i++) {
      recoverInProgressOrphans(db, ws as never, new Set(), {
        spawnAgent: fakeSpawn,
        maxAutoRespawn: 3,
        pending,
      });
    }

    assert.equal(spawnCalls, 0, "no spawns during preflight");
    const row = db.prepare("SELECT auto_respawn_count FROM tasks WHERE id = 't1'").get() as {
      auto_respawn_count: number;
    };
    assert.equal(row.auto_respawn_count, 0, "budget must stay at 0 throughout preflight");
  });

  it("does not issue duplicate auto-respawn attempts while a respawn preflight is still in flight", async () => {
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();

    let spawnCalls = 0;
    let resolveSpawn: (() => void) | null = null;
    const fakeSpawn = (() => {
      spawnCalls += 1;
      return new Promise<{ pid: number }>((resolve) => {
        resolveSpawn = () => resolve({ pid: 1 });
      });
    }) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
    });
    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
    });
    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
    });

    assert.equal(spawnCalls, 1, "respawn must stay single while preflight is unresolved");
    const row = db.prepare("SELECT auto_respawn_count FROM tasks WHERE id = 't1'").get() as {
      auto_respawn_count: number;
    };
    assert.equal(row.auto_respawn_count, 1, "budget must only advance once during one preflight window");

    const logs = db.prepare(
      "SELECT COUNT(*) AS n FROM task_logs WHERE task_id = 't1' AND message LIKE 'Orphan recovery: auto-respawn attempt%'",
    ).get() as { n: number };
    assert.equal(logs.n, 1, "only one auto-respawn attempt log should be written");

    if (!resolveSpawn) {
      throw new Error("expected in-flight spawn resolver to be captured");
    }
    const finishSpawn = resolveSpawn as () => void;
    finishSpawn();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("rolls back auto_respawn_count when auto-respawn fails with non-retryable workspace preflight", async () => {
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();

    const fakeSpawn = (() => Promise.reject(
      new SpawnPreflightError(
        "workspace_repository_mismatch",
        "repository_url does not match project_path origin; task_id=t1; project_path=/repo; git_toplevel=/repo; actual_repository_url=https://github.com/acme/wrong; expected_repository_url=https://github.com/acme/right",
        false,
      ),
    )) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
    });

    await new Promise((resolve) => setImmediate(resolve));

    const row = db.prepare("SELECT status, auto_respawn_count FROM tasks WHERE id = 't1'").get() as {
      status: string;
      auto_respawn_count: number;
    };
    assert.equal(row.status, "human_review");
    assert.equal(row.auto_respawn_count, 0);

    const log = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = 't1' AND message LIKE '%expected_repository_url=%' ORDER BY id DESC LIMIT 1",
    ).get() as { message: string } | undefined;
    assert.ok(log?.message);
  });

  it("allows a new auto-respawn only after the previous in-flight respawn settles", async () => {
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();

    let spawnCalls = 0;
    let resolveFirstSpawn: (() => void) | null = null;
    const fakeSpawn = (() => {
      spawnCalls += 1;
      if (spawnCalls === 1) {
        return new Promise<{ pid: number }>((resolve) => {
          resolveFirstSpawn = () => resolve({ pid: 1 });
        });
      }
      return Promise.resolve({ pid: spawnCalls });
    }) as never;

    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
    });
    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
    });

    assert.equal(spawnCalls, 1, "preflight window must suppress duplicate respawns");

    if (!resolveFirstSpawn) {
      throw new Error("expected first in-flight spawn resolver to be captured");
    }
    const finishFirstSpawn = resolveFirstSpawn as () => void;
    finishFirstSpawn();
    await new Promise((resolve) => setImmediate(resolve));

    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
    });

    assert.equal(spawnCalls, 2, "next tick may retry only after the previous preflight settles");
    const row = db.prepare("SELECT auto_respawn_count FROM tasks WHERE id = 't1'").get() as {
      auto_respawn_count: number;
    };
    assert.equal(row.auto_respawn_count, 2);
  });

  it("recovers a genuine orphan even when other tasks are in pendingSpawns", () => {
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();

    // Insert a second agent for t2
    const now = Date.now();
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("agent-2", "tester-2", "claude", "idle", now, now);
    insertTask(db, { id: "t2", status: "in_progress", assigned_agent_id: "agent-2" });

    const ws = createFakeWs();

    const spawnedTasks: string[] = [];
    const fakeSpawn = ((_db: DatabaseSync, _ws: unknown, _agent: unknown, task: { id: string }) => {
      spawnedTasks.push(task.id);
      return Promise.resolve({ pid: 1 });
    }) as never;

    // t1 is in pendingSpawns (preflight), t2 is a genuine orphan
    const pending = new Set(["t1"]);
    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
      pending,
    });

    assert.ok(!spawnedTasks.includes("t1"), "t1 must not be respawned (in preflight)");
    assert.ok(spawnedTasks.includes("t2"), "t2 must be respawned (genuine orphan)");
  });

  it("skips refinement tasks in pendingSpawns (preflight applies to all orphan candidates)", () => {
    insertTask(db, { id: "t1", status: "refinement", assigned_agent_id: "agent-1" });
    const ws = createFakeWs();

    const pending = new Set(["t1"]);
    recoverInProgressOrphans(db, ws as never, new Set(), { pending });

    const row = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string };
    assert.equal(row.status, "refinement", "must not bounce to inbox during preflight");
    assert.equal(ws.events.length, 0, "no broadcasts during preflight");
  });

  it("recovers task after preflight completes (pendingSpawns cleared)", () => {
    insertTask(db, { id: "t1", status: "in_progress", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();

    let spawnCalls = 0;
    const fakeSpawn = (() => {
      spawnCalls += 1;
      return Promise.resolve({ pid: 1 });
    }) as never;

    const pending = new Set(["t1"]);

    // Tick 1: task in preflight → skipped
    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
      pending,
    });
    assert.equal(spawnCalls, 0, "skipped during preflight");

    // Preflight completes: task removed from pendingSpawns
    pending.delete("t1");

    // Tick 2: task is now a genuine orphan → respawned
    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
      pending,
    });
    assert.equal(spawnCalls, 1, "respawned after preflight completed");
  });

  it("does not emit park log for budget-exhausted tasks in pendingSpawns", () => {
    insertTask(db, {
      id: "t1",
      status: "in_progress",
      assigned_agent_id: "agent-1",
      auto_respawn_count: 3,
    });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-1'").run();
    const ws = createFakeWs();

    const pending = new Set(["t1"]);
    recoverInProgressOrphans(db, ws as never, new Set(), {
      spawnAgent: (() => Promise.resolve({ pid: 1 })) as never,
      maxAutoRespawn: 3,
      pending,
    });

    const logs = db.prepare("SELECT COUNT(*) AS n FROM task_logs WHERE task_id = 't1'").get() as { n: number };
    assert.equal(logs.n, 0, "no park/budget-exhausted log during preflight");
  });

  it("skips refinement-with-plan tasks in pendingSpawns", () => {
    insertTask(db, { id: "t1", status: "refinement", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE tasks SET refinement_plan = 'some plan' WHERE id = 't1'").run();
    const ws = createFakeWs();

    const pending = new Set(["t1"]);
    recoverInProgressOrphans(db, ws as never, new Set(), { pending });

    const row = db.prepare("SELECT status, completed_at FROM tasks WHERE id = 't1'").get() as {
      status: string;
      completed_at: number | null;
    };
    assert.equal(row.status, "refinement", "must not finalize during preflight");
    assert.equal(row.completed_at, null, "completed_at must not be stamped during preflight");
    assert.equal(ws.events.length, 0, "no broadcasts during preflight");
  });

  it("handles three-way interaction: active + pending + genuine orphan", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("agent-2", "tester-2", "claude", "idle", now, now);
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("agent-3", "tester-3", "claude", "idle", now, now);

    insertTask(db, { id: "t-active", status: "in_progress", assigned_agent_id: "agent-1" });
    insertTask(db, { id: "t-pending", status: "in_progress", assigned_agent_id: "agent-2" });
    insertTask(db, { id: "t-orphan", status: "in_progress", assigned_agent_id: "agent-3" });

    const ws = createFakeWs();
    const spawnedTasks: string[] = [];
    const fakeSpawn = ((_db: DatabaseSync, _ws: unknown, _agent: unknown, task: { id: string }) => {
      spawnedTasks.push(task.id);
      return Promise.resolve({ pid: 1 });
    }) as never;

    const active = new Set(["t-active"]);
    const pending = new Set(["t-pending"]);
    recoverInProgressOrphans(db, ws as never, active, {
      spawnAgent: fakeSpawn,
      maxAutoRespawn: 3,
      pending,
    });

    assert.ok(!spawnedTasks.includes("t-active"), "active task must not be respawned");
    assert.ok(!spawnedTasks.includes("t-pending"), "pending task must not be respawned");
    assert.ok(spawnedTasks.includes("t-orphan"), "genuine orphan must be respawned");
    assert.equal(spawnedTasks.length, 1, "exactly one task respawned");
  });

  it("broadcasts task summary update with has_refinement_plan flag for refinement orphan with plan", () => {
    insertTask(db, { id: "t3", status: "refinement", assigned_agent_id: "agent-1" });
    db.prepare("UPDATE tasks SET refinement_plan = 'the plan' WHERE id = 't3'").run();
    const ws = createFakeWs();

    recoverInProgressOrphans(db, ws as never, new Set());

    const taskUpdate = ws.events.find((e) => e.type === "task_update");
    assert.ok(taskUpdate, "expected task_update broadcast");
    const payload = taskUpdate!.payload as Record<string, unknown>;
    // After cache 撤去 + /tasks summary 化 (#82130), WS broadcasts no
    // longer ship full Task rows. Heavy fields like `refinement_plan`
    // are excluded; the `has_refinement_plan` derived flag carries the
    // "plan exists" signal needed by the kanban Plan banner.
    assert.equal(payload.refinement_plan, undefined, "broadcast must NOT include refinement_plan body");
    assert.equal(payload.has_refinement_plan, true, "broadcast must include has_refinement_plan: true");
    assert.ok(payload.completed_at, "broadcast must include completed_at");
    assert.equal(payload.status, "refinement");
  });

  it("stamps refinement_revision_completed_at for orphan with pending revision", () => {
    const requestedAt = Date.now() - 60_000;
    insertTask(db, { id: "t4", status: "refinement", assigned_agent_id: "agent-1" });
    db.prepare(
      "UPDATE tasks SET refinement_plan = 'plan v2', refinement_revision_requested_at = ?, refinement_revision_completed_at = NULL WHERE id = 't4'",
    ).run(requestedAt);
    const ws = createFakeWs();

    recoverInProgressOrphans(db, ws as never, new Set());

    const row = db.prepare(
      "SELECT refinement_revision_completed_at FROM tasks WHERE id = 't4'",
    ).get() as { refinement_revision_completed_at: number | null };
    assert.ok(row.refinement_revision_completed_at !== null, "revision must be stamped as completed");
    assert.ok(row.refinement_revision_completed_at! >= requestedAt, "completed_at must be after requested_at");

    const taskUpdate = ws.events.find((e) => e.type === "task_update");
    const payload = taskUpdate!.payload as Record<string, unknown>;
    assert.ok(payload.refinement_revision_completed_at, "broadcast must include refinement_revision_completed_at");
  });

  it("does not stamp refinement_revision_completed_at when no revision was requested", () => {
    insertTask(db, { id: "t5", status: "refinement", assigned_agent_id: "agent-1" });
    db.prepare(
      "UPDATE tasks SET refinement_plan = 'plan v1', refinement_revision_requested_at = NULL WHERE id = 't5'",
    ).run();
    const ws = createFakeWs();

    recoverInProgressOrphans(db, ws as never, new Set());

    const row = db.prepare(
      "SELECT refinement_revision_completed_at FROM tasks WHERE id = 't5'",
    ).get() as { refinement_revision_completed_at: number | null };
    assert.equal(row.refinement_revision_completed_at, null, "must not stamp when no revision was requested");
  });

  it("is idempotent when completed_at is already set", () => {
    const alreadyCompleted = Date.now() - 120_000;
    insertTask(db, { id: "t6", status: "refinement", assigned_agent_id: "agent-1" });
    db.prepare(
      "UPDATE tasks SET refinement_plan = 'plan', completed_at = ? WHERE id = 't6'",
    ).run(alreadyCompleted);
    const ws = createFakeWs();

    recoverInProgressOrphans(db, ws as never, new Set());

    const row = db.prepare(
      "SELECT completed_at FROM tasks WHERE id = 't6'",
    ).get() as { completed_at: number | null };
    assert.equal(row.completed_at, alreadyCompleted, "completed_at must not be overwritten");

    const taskUpdates = ws.events.filter((e) => e.type === "task_update");
    assert.equal(taskUpdates.length, 0, "no broadcast when already completed");
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

    recoverStuckAutoStages(db, ws as never, new Set(), PAST_START);

    const row = db.prepare("SELECT status FROM tasks WHERE id = 'stuck'").get() as { status: string };
    assert.equal(row.status, "human_review");
    assert.ok(ws.events.some((e) => e.type === "task_update"));
  });

  it("promotes stuck qa_testing / test_generation tasks", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    for (const [id, status] of [
      ["qa", "qa_testing"],
      ["tg", "test_generation"],
    ] as const) {
      insertTask(db, { id, status, assigned_agent_id: "agent-1", last_heartbeat_at: elevenMinutesAgo });
    }
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, new Set(), PAST_START);

    const rows = db.prepare("SELECT id, status FROM tasks WHERE id IN ('qa','tg')").all() as Array<{
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

    recoverStuckAutoStages(db, ws as never, new Set(), PAST_START);

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

    recoverStuckAutoStages(db, ws as never, new Set(), PAST_START);

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
    recoverStuckAutoStages(db, ws as never, new Set(), Date.now());

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

    recoverStuckAutoStages(db, ws as never, new Set(["alive"]), PAST_START);

    const row = db.prepare("SELECT status FROM tasks WHERE id = 'alive'").get() as { status: string };
    assert.equal(row.status, "pr_review");
  });

  it("ignores tasks in non-auto stages (inbox, done, etc.)", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    insertTask(db, { id: "inbox-old", status: "inbox", updated_at: elevenMinutesAgo });
    insertTask(db, { id: "done-old", status: "done", updated_at: elevenMinutesAgo });
    insertTask(db, { id: "human-old", status: "human_review", updated_at: elevenMinutesAgo });
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, new Set(), PAST_START);

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

    recoverStuckAutoStages(db, ws as never, new Set(), PAST_START);

    const log = db
      .prepare("SELECT message FROM task_logs WHERE task_id = 'stuck' AND kind = 'system' ORDER BY id DESC LIMIT 1")
      .get() as { message: string };
    assert.match(log.message, /promoted to human_review/);
    assert.match(log.message, /pr_review/);
  });

  it("skips auto-stage tasks in pendingSpawns", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    insertTask(db, {
      id: "preflight",
      status: "pr_review",
      assigned_agent_id: "agent-1",
      last_heartbeat_at: elevenMinutesAgo,
    });
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, new Set(), PAST_START, new Set(["preflight"]));

    const row = db.prepare("SELECT status FROM tasks WHERE id = 'preflight'").get() as { status: string };
    assert.equal(row.status, "pr_review", "must not promote a task in pendingSpawns");
    assert.equal(ws.events.length, 0);
  });

  it("selectively promotes only non-pending auto-stage tasks", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    const now = Date.now();
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("agent-2", "tester-2", "claude", "idle", now, now);

    insertTask(db, {
      id: "pending-task",
      status: "pr_review",
      assigned_agent_id: "agent-1",
      last_heartbeat_at: elevenMinutesAgo,
    });
    insertTask(db, {
      id: "genuine-stuck",
      status: "qa_testing",
      assigned_agent_id: "agent-2",
      last_heartbeat_at: elevenMinutesAgo,
    });
    const ws = createFakeWs();

    recoverStuckAutoStages(db, ws as never, new Set(), PAST_START, new Set(["pending-task"]));

    const pendingRow = db.prepare("SELECT status FROM tasks WHERE id = 'pending-task'").get() as { status: string };
    assert.equal(pendingRow.status, "pr_review", "pending task stays in pr_review");

    const genuineRow = db.prepare("SELECT status FROM tasks WHERE id = 'genuine-stuck'").get() as { status: string };
    assert.equal(genuineRow.status, "human_review", "genuine stuck task promoted to human_review");
  });

  it("does not promote pending auto-stage tasks across multiple ticks", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    insertTask(db, {
      id: "preflight",
      status: "pr_review",
      assigned_agent_id: "agent-1",
      last_heartbeat_at: elevenMinutesAgo,
    });
    const ws = createFakeWs();

    const pending = new Set(["preflight"]);
    for (let i = 0; i < 5; i++) {
      recoverStuckAutoStages(db, ws as never, new Set(), PAST_START, pending);
    }

    const row = db.prepare("SELECT status FROM tasks WHERE id = 'preflight'").get() as { status: string };
    assert.equal(row.status, "pr_review", "must stay in pr_review across all ticks");
    assert.equal(ws.events.length, 0, "no broadcasts across any tick");
    const logs = db.prepare("SELECT COUNT(*) AS n FROM task_logs WHERE task_id = 'preflight'").get() as { n: number };
    assert.equal(logs.n, 0, "no system logs emitted during preflight");
  });

  it("promotes auto-stage task after preflight completes (pendingSpawns cleared)", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    insertTask(db, {
      id: "lifecycle",
      status: "pr_review",
      assigned_agent_id: "agent-1",
      last_heartbeat_at: elevenMinutesAgo,
    });
    const ws = createFakeWs();

    const pending = new Set(["lifecycle"]);

    // Tick 1: task in preflight → skipped
    recoverStuckAutoStages(db, ws as never, new Set(), PAST_START, pending);
    const before = db.prepare("SELECT status FROM tasks WHERE id = 'lifecycle'").get() as { status: string };
    assert.equal(before.status, "pr_review", "skipped during preflight");

    // Preflight completes
    pending.delete("lifecycle");

    // Tick 2: task is now genuinely stuck → promoted
    recoverStuckAutoStages(db, ws as never, new Set(), PAST_START, pending);
    const after = db.prepare("SELECT status FROM tasks WHERE id = 'lifecycle'").get() as { status: string };
    assert.equal(after.status, "human_review", "promoted after preflight completed");
  });
});
