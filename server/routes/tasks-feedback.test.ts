import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CacheService } from "../cache/cache-service.js";
import { SCHEMA_SQL } from "../db/schema.js";
import { createTasksRouter } from "./tasks.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS task_logs_fill_metadata
    AFTER INSERT ON task_logs
    FOR EACH ROW
    WHEN NEW.stage IS NULL OR NEW.agent_id IS NULL
    BEGIN
      UPDATE task_logs
      SET stage = COALESCE(NEW.stage, (SELECT status FROM tasks WHERE id = NEW.task_id)),
          agent_id = COALESCE(NEW.agent_id, (SELECT assigned_agent_id FROM tasks WHERE id = NEW.task_id))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_log_stage_transition
    AFTER UPDATE OF status ON tasks
    FOR EACH ROW
    WHEN NEW.status IS NOT OLD.status
    BEGIN
      INSERT INTO task_logs (task_id, kind, message, stage, agent_id)
      VALUES (
        NEW.id,
        'system',
        '__STAGE_TRANSITION__:' || COALESCE(OLD.status, 'null') || '→' || NEW.status,
        NEW.status,
        NEW.assigned_agent_id
      );
    END;
  `);
  return db;
}

function createCache(): CacheService {
  return {
    async get() {
      return null;
    },
    async set() {},
    async del() {},
    async invalidatePattern() {},
    get isConnected() {
      return false;
    },
  };
}

function createWsRecorder() {
  const events: Array<{ type: string; payload: unknown; options?: unknown }> = [];
  return {
    ws: {
      broadcast(type: string, payload: unknown, options?: unknown) {
        events.push({ type, payload, options });
      },
    },
    events,
  };
}

async function startServer(
  db: DatabaseSync,
  deps: Parameters<typeof createTasksRouter>[1],
): Promise<{ server: Server; baseUrl: string; events: Array<{ type: string; payload: unknown; options?: unknown }> }> {
  const { ws, events } = createWsRecorder();
  const app = express();
  app.use(express.json());
  app.use(createTasksRouter({ db, ws: ws as never, cache: createCache() }, deps));

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server address unavailable");
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}`, events };
}

function insertAgent(db: DatabaseSync, agentId: string, status: "idle" | "working"): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at)
     VALUES (?, ?, 'claude', ?, ?, ?)`,
  ).run(agentId, `Agent ${agentId}`, status, now, now);
}

function insertRefinementTask(db: DatabaseSync, taskId: string, agentId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'refinement', 'medium', ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "Refinement feedback regression", agentId, `#${taskId.slice(0, 6)}`, now, now);
}

function getTransitions(db: DatabaseSync, taskId: string): string[] {
  return (
    db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '__STAGE_TRANSITION__:%' ORDER BY id ASC",
    ).all(taskId) as Array<{ message: string }>
  ).map((row) => row.message);
}

describe("POST /tasks/:id/feedback refinement regressions", () => {
  let db: DatabaseSync;
  let server: Server;

  afterEach(async () => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    db.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("each test gets a fresh in-memory DB with no leaked rows", async () => {
    db = createDb();
    const agentId = randomUUID();
    insertAgent(db, agentId, "idle");
    const taskId = randomUUID();
    insertRefinementTask(db, taskId, agentId);

    const agentCount = (db.prepare("SELECT COUNT(*) AS cnt FROM agents").get() as { cnt: number }).cnt;
    const taskCount = (db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get() as { cnt: number }).cnt;
    assert.equal(agentCount, 1, "fresh DB should contain exactly one agent");
    assert.equal(taskCount, 1, "fresh DB should contain exactly one task");

    const started = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 } as never),
    });
    server = started.server;
  });

  it("still has zero leftover rows from the previous test", async () => {
    db = createDb();
    const agentCount = (db.prepare("SELECT COUNT(*) AS cnt FROM agents").get() as { cnt: number }).cnt;
    const taskCount = (db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get() as { cnt: number }).cnt;
    assert.equal(agentCount, 0, "no agent rows should leak between tests");
    assert.equal(taskCount, 0, "no task rows should leak between tests");

    const started = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 } as never),
    });
    server = started.server;
  });

  it("returns 404 for a nonexistent task", async () => {
    db = createDb();
    const started = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 } as never),
    });
    server = started.server;

    const response = await fetch(`${started.baseUrl}/tasks/${randomUUID()}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    assert.equal(response.status, 404);
    const body = await response.json() as { error: string };
    assert.equal(body.error, "not_found");
  });

  it("returns 400 when content is empty", async () => {
    db = createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId);

    const started = await startServer(db, {
      queueFeedbackAndRestart: () => true,
      spawnAgent: async () => ({ pid: 0 } as never),
    });
    server = started.server;

    const response = await fetch(`${started.baseUrl}/tasks/${taskId}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    assert.equal(response.status, 400);
  });

  it("records one refinement round-trip when an active child process is restarted", async () => {
    db = createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId);

    let queueCalls = 0;
    let spawnCalls = 0;
    const started = await startServer(db, {
      queueFeedbackAndRestart: () => {
        queueCalls += 1;
        return true;
      },
      spawnAgent: async () => {
        spawnCalls += 1;
        throw new Error("spawnAgent should not run when feedback restart stays in-process");
      },
    });
    server = started.server;

    const response = await fetch(`${started.baseUrl}/tasks/${taskId}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Revise the plan." }),
    });
    assert.equal(response.status, 200);

    const body = await response.json() as { restarted: boolean };
    assert.equal(body.restarted, true);
    assert.equal(queueCalls, 1);
    assert.equal(spawnCalls, 0);
    assert.deepEqual(getTransitions(db, taskId), [
      "__STAGE_TRANSITION__:refinement→inbox",
      "__STAGE_TRANSITION__:inbox→refinement",
    ]);
  });

  it("does not duplicate transitions when feedback falls through to idle-agent respawn", async () => {
    db = createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    let spawnCalls = 0;
    let spawnedTaskStatus: string | undefined;
    let spawnedPreviousStatus: string | undefined;
    let spawnedPrompt: string | undefined;
    const started = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task, options) => {
        spawnCalls += 1;
        spawnedTaskStatus = task.status;
        spawnedPreviousStatus = options?.previousStatus;
        spawnedPrompt = options?.continuePrompt;
        return { pid: 1234 } as never;
      },
    });
    server = started.server;

    const response = await fetch(`${started.baseUrl}/tasks/${taskId}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Tighten the acceptance criteria." }),
    });
    assert.equal(response.status, 200);

    const body = await response.json() as { restarted: boolean };
    assert.equal(body.restarted, true);
    assert.equal(spawnCalls, 1);
    assert.equal(spawnedTaskStatus, "refinement");
    assert.equal(spawnedPreviousStatus, "refinement");
    assert.equal(spawnedPrompt, "Tighten the acceptance criteria.");
    assert.deepEqual(getTransitions(db, taskId), [
      "__STAGE_TRANSITION__:refinement→inbox",
      "__STAGE_TRANSITION__:inbox→refinement",
    ]);
    assert.ok(
      started.events.some((event) => event.type === "task_update"),
      "expected a task_update broadcast for the respawned refinement task",
    );
  });

  it("resets auto_respawn_count and sets in_progress for non-refinement feedback on idle agent", async () => {
    db = createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");

    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        auto_respawn_count, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'in_progress', 'medium', ?, 3, ?, ?, ?)`,
    ).run(taskId, `Task ${taskId}`, "Non-refinement feedback", agentId, `#${taskId.slice(0, 6)}`, now, now, now);

    const started = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 } as never),
    });
    server = started.server;

    const response = await fetch(`${started.baseUrl}/tasks/${taskId}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Fix the output format." }),
    });
    assert.equal(response.status, 200);

    const updated = db.prepare("SELECT status, auto_respawn_count, completed_at FROM tasks WHERE id = ?").get(taskId) as {
      status: string;
      auto_respawn_count: number;
      completed_at: number | null;
    };
    assert.equal(updated.status, "in_progress");
    assert.equal(updated.auto_respawn_count, 0, "auto_respawn_count should be reset to 0");
    assert.equal(updated.completed_at, null, "completed_at should be cleared");
  });

  it("returns restarted:false when task has no assigned agent", async () => {
    db = createDb();
    const taskId = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 'refinement', 'medium', ?, ?, ?)`,
    ).run(taskId, `Task ${taskId}`, "Unassigned refinement", `#${taskId.slice(0, 6)}`, now, now);

    const started = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        throw new Error("spawnAgent should not be called for unassigned tasks");
      },
    });
    server = started.server;

    const response = await fetch(`${started.baseUrl}/tasks/${taskId}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Revise this." }),
    });
    assert.equal(response.status, 200);

    const body = await response.json() as { restarted: boolean };
    assert.equal(body.restarted, false, "should not restart when no agent is assigned");
  });
});
