import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";

import { SCHEMA_SQL } from "../db/schema.js";
import {
  reconcileStaleAgentPointers,
  releaseAgentsForDeletedTask,
} from "./agent-pointer-reconcile.js";

interface WsEvent {
  type: string;
  payload: unknown;
}

interface FakeWs {
  events: WsEvent[];
  broadcast: (type: string, payload: unknown) => void;
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

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

function insertAgent(
  db: DatabaseSync,
  id: string,
  status: "idle" | "working" | "offline",
  currentTaskId: string | null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (id, name, cli_provider, status, current_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `agent-${id}`, "claude", status, currentTaskId, now, now);
}

function insertTask(db: DatabaseSync, id: string, status: string, agentId?: string | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, task_size, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'small', ?, ?)`,
  ).run(id, `title-${id}`, status, agentId ?? null, now, now);
}

describe("reconcileStaleAgentPointers", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it("releases a working agent whose task no longer exists", () => {
    insertAgent(db, "a1", "working", "missing-task");
    const ws = createFakeWs();

    const { released } = reconcileStaleAgentPointers(db, ws as never);

    assert.equal(released.length, 1);
    assert.equal(released[0].id, "a1");
    assert.equal(released[0].reason, "missing");

    const agent = db
      .prepare("SELECT status, current_task_id FROM agents WHERE id = 'a1'")
      .get() as { status: string; current_task_id: string | null };
    assert.equal(agent.status, "idle");
    assert.equal(agent.current_task_id, null);

    assert.deepEqual(ws.events[0], {
      type: "agent_status",
      payload: { id: "a1", status: "idle", current_task_id: null },
    });
  });

  it("releases a working agent whose task is done", () => {
    insertTask(db, "t-done", "done");
    insertAgent(db, "a1", "working", "t-done");
    const ws = createFakeWs();

    const { released } = reconcileStaleAgentPointers(db, ws as never);

    assert.equal(released.length, 1);
    assert.equal(released[0].reason, "done");
    const agent = db.prepare("SELECT status FROM agents WHERE id = 'a1'").get() as { status: string };
    assert.equal(agent.status, "idle");
  });

  it("releases a working agent whose task is cancelled", () => {
    insertTask(db, "t-cancel", "cancelled");
    insertAgent(db, "a1", "working", "t-cancel");
    const ws = createFakeWs();

    const { released } = reconcileStaleAgentPointers(db, ws as never);

    assert.equal(released.length, 1);
    assert.equal(released[0].reason, "cancelled");
  });

  it("releases a working agent with a NULL current_task_id (structurally invalid)", () => {
    insertAgent(db, "a1", "working", null);
    const ws = createFakeWs();

    const { released } = reconcileStaleAgentPointers(db, ws as never);

    assert.equal(released.length, 1);
    assert.equal(released[0].reason, "null_pointer");
  });

  it("does NOT release a working agent whose task is in_progress", () => {
    insertTask(db, "t-active", "in_progress");
    insertAgent(db, "a1", "working", "t-active");
    const ws = createFakeWs();

    const { released } = reconcileStaleAgentPointers(db, ws as never);

    assert.equal(released.length, 0);
    const agent = db.prepare("SELECT status FROM agents WHERE id = 'a1'").get() as { status: string };
    assert.equal(agent.status, "working");
    assert.equal(ws.events.length, 0);
  });

  it("does NOT release a working agent whose task has a live process even if status is done", () => {
    // Edge case: a process is still running while the task is being
    // finalized — keep the agent working until the process closes naturally.
    insertTask(db, "t-finalizing", "done");
    insertAgent(db, "a1", "working", "t-finalizing");
    const ws = createFakeWs();

    const { released } = reconcileStaleAgentPointers(db, ws as never, {
      activeTaskIds: new Set(["t-finalizing"]),
    });

    assert.equal(released.length, 0);
    const agent = db.prepare("SELECT status FROM agents WHERE id = 'a1'").get() as { status: string };
    assert.equal(agent.status, "working");
  });

  it("ignores idle and offline agents", () => {
    insertAgent(db, "a1", "idle", null);
    insertAgent(db, "a2", "offline", "ghost-task");
    const ws = createFakeWs();

    const { released } = reconcileStaleAgentPointers(db, ws as never);

    assert.equal(released.length, 0);
    assert.equal(ws.events.length, 0);
  });

  it("releases multiple stale agents in a single sweep", () => {
    insertTask(db, "t-done", "done");
    insertAgent(db, "a1", "working", "missing");
    insertAgent(db, "a2", "working", "t-done");
    insertAgent(db, "a3", "working", null);
    const ws = createFakeWs();

    const { released } = reconcileStaleAgentPointers(db, ws as never);

    assert.equal(released.length, 3);
    const ids = released.map((r) => r.id).sort();
    assert.deepEqual(ids, ["a1", "a2", "a3"]);
    assert.equal(ws.events.filter((e) => e.type === "agent_status").length, 3);
  });

  it("accepts a Map for activeTaskIds (matches getActiveProcesses())", () => {
    insertTask(db, "t-finalizing", "done");
    insertAgent(db, "a1", "working", "t-finalizing");
    const ws = createFakeWs();

    const activeMap = new Map<string, unknown>();
    activeMap.set("t-finalizing", { fake: true });

    const { released } = reconcileStaleAgentPointers(db, ws as never, {
      activeTaskIds: activeMap,
    });

    assert.equal(released.length, 0, "Map active should be honored");
  });

  it("returns empty result when no agents exist", () => {
    const ws = createFakeWs();
    const { released } = reconcileStaleAgentPointers(db, ws as never);
    assert.equal(released.length, 0);
    assert.equal(ws.events.length, 0);
  });

  it("does NOT release a working agent whose task is in a non-terminal active status", () => {
    const activeStatuses = ["inbox", "refinement", "test_generation", "qa_testing", "pr_review", "human_review"];
    for (const status of activeStatuses) {
      const localDb = createDb();
      insertTask(localDb, `t-${status}`, status);
      insertAgent(localDb, `a-${status}`, "working", `t-${status}`);
      const ws = createFakeWs();

      const { released } = reconcileStaleAgentPointers(localDb, ws as never);

      assert.equal(released.length, 0, `should NOT release agent for task in ${status}`);
      const agent = localDb
        .prepare(`SELECT status FROM agents WHERE id = 'a-${status}'`)
        .get() as { status: string };
      assert.equal(agent.status, "working", `agent should remain working for task in ${status}`);
      localDb.close();
    }
  });

  it("updates the agent's updated_at timestamp on release", () => {
    const past = Date.now() - 60_000;
    db.prepare(
      `INSERT INTO agents (id, name, cli_provider, status, current_task_id, created_at, updated_at)
       VALUES ('a1', 'agent-a1', 'claude', 'working', 'missing-task', ?, ?)`,
    ).run(past, past);
    const ws = createFakeWs();

    reconcileStaleAgentPointers(db, ws as never);

    const agent = db
      .prepare("SELECT updated_at FROM agents WHERE id = 'a1'")
      .get() as { updated_at: number };
    assert.ok(agent.updated_at > past, "updated_at should be bumped forward");
  });

  it("skips an agent concurrently released between SELECT and UPDATE", () => {
    insertAgent(db, "a1", "working", "missing-task");
    const ws = createFakeWs();

    db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = 'a1'").run();

    const { released } = reconcileStaleAgentPointers(db, ws as never);

    assert.equal(released.length, 0, "should skip already-released agent");
    assert.equal(ws.events.length, 0);
  });
});

describe("releaseAgentsForDeletedTask", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it("releases the agent currently pointing at the deleted task", () => {
    // NOTE: tasks.assigned_agent_id has FK ON DELETE SET NULL, so we
    // simulate the post-DELETE state by leaving the task row out entirely.
    insertAgent(db, "a1", "working", "t-gone");
    const ws = createFakeWs();

    const released = releaseAgentsForDeletedTask(db, ws as never, "t-gone");

    assert.deepEqual(released, ["a1"]);
    const agent = db
      .prepare("SELECT status, current_task_id FROM agents WHERE id = 'a1'")
      .get() as { status: string; current_task_id: string | null };
    assert.equal(agent.status, "idle");
    assert.equal(agent.current_task_id, null);
    assert.deepEqual(ws.events[0], {
      type: "agent_status",
      payload: { id: "a1", status: "idle", current_task_id: null },
    });
  });

  it("returns an empty list when no agent points at the task", () => {
    insertAgent(db, "a1", "working", "different-task");
    const ws = createFakeWs();

    const released = releaseAgentsForDeletedTask(db, ws as never, "t-gone");

    assert.deepEqual(released, []);
    assert.equal(ws.events.length, 0);
  });

  it("releases multiple agents that all point at the same task", () => {
    // Defensive: the schema does not prevent two agents from sharing a
    // current_task_id even though spawnAgent guards against it. Make sure
    // the DELETE cleanup still scrubs them all.
    insertAgent(db, "a1", "working", "t-shared");
    insertAgent(db, "a2", "working", "t-shared");
    const ws = createFakeWs();

    const released = releaseAgentsForDeletedTask(db, ws as never, "t-shared");

    assert.deepEqual(released.sort(), ["a1", "a2"]);
    const rows = db
      .prepare("SELECT id, status FROM agents WHERE id IN ('a1','a2') ORDER BY id")
      .all() as Array<{ id: string; status: string }>;
    for (const r of rows) assert.equal(r.status, "idle");
  });

  it("cleans up a stale pointer on an idle agent", () => {
    insertAgent(db, "a1", "idle", "t-gone");
    const ws = createFakeWs();

    const released = releaseAgentsForDeletedTask(db, ws as never, "t-gone");

    assert.deepEqual(released, ["a1"]);
    const agent = db
      .prepare("SELECT current_task_id FROM agents WHERE id = 'a1'")
      .get() as { current_task_id: string | null };
    assert.equal(agent.current_task_id, null);
  });

  it("cleans up a stale pointer on an offline agent", () => {
    insertAgent(db, "a1", "offline", "t-gone");
    const ws = createFakeWs();

    const released = releaseAgentsForDeletedTask(db, ws as never, "t-gone");

    assert.deepEqual(released, ["a1"]);
    const agent = db
      .prepare("SELECT status, current_task_id FROM agents WHERE id = 'a1'")
      .get() as { status: string; current_task_id: string | null };
    assert.equal(agent.status, "idle");
    assert.equal(agent.current_task_id, null);
  });

  it("updates the agent's updated_at timestamp on release", () => {
    const past = Date.now() - 60_000;
    db.prepare(
      `INSERT INTO agents (id, name, cli_provider, status, current_task_id, created_at, updated_at)
       VALUES ('a1', 'agent-a1', 'claude', 'working', 't-gone', ?, ?)`,
    ).run(past, past);
    const ws = createFakeWs();

    releaseAgentsForDeletedTask(db, ws as never, "t-gone");

    const agent = db
      .prepare("SELECT updated_at FROM agents WHERE id = 'a1'")
      .get() as { updated_at: number };
    assert.ok(agent.updated_at > past, "updated_at should be bumped forward");
  });

  it("returns empty when no agents exist in the database", () => {
    const ws = createFakeWs();
    const released = releaseAgentsForDeletedTask(db, ws as never, "t-gone");
    assert.deepEqual(released, []);
    assert.equal(ws.events.length, 0);
  });
});
