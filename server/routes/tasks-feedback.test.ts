import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { before, after, afterEach, describe, it } from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CacheService } from "../cache/cache-service.js";
import { SCHEMA_SQL } from "../db/schema.js";
import { createTasksRouter } from "./tasks.js";

function createTestDb(): DatabaseSync {
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

let taskCounter = 0;

function insertRefinementTask(db: DatabaseSync, taskId: string, agentId: string): void {
  const now = Date.now();
  taskCounter += 1;
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'refinement', 'medium', ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "Refinement feedback regression", agentId, `#${taskCounter}`, now, now);
}

function getTransitions(db: DatabaseSync, taskId: string): string[] {
  return (
    db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '__STAGE_TRANSITION__:%' ORDER BY id ASC",
    ).all(taskId) as Array<{ message: string }>
  ).map((row) => row.message);
}

describe("createTestDb isolation guarantees", () => {
  it("uses an in-memory database with no file-system side effects", () => {
    const db = createTestDb();
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      assert.ok(tableNames.includes("tasks"), "tasks table should exist");
      assert.ok(tableNames.includes("agents"), "agents table should exist");
      assert.ok(tableNames.includes("task_logs"), "task_logs table should exist");
    } finally {
      db.close();
    }
  });

  it("each call returns an independent database with no shared state", () => {
    const db1 = createTestDb();
    const db2 = createTestDb();
    try {
      const agentId = randomUUID();
      insertAgent(db1, agentId, "idle");

      const inDb1 = db1.prepare("SELECT COUNT(*) AS cnt FROM agents").get() as { cnt: number };
      const inDb2 = db2.prepare("SELECT COUNT(*) AS cnt FROM agents").get() as { cnt: number };

      assert.equal(inDb1.cnt, 1, "db1 should have one agent");
      assert.equal(inDb2.cnt, 0, "db2 should remain empty");
    } finally {
      db1.close();
      db2.close();
    }
  });

  it("taskCounter produces predictable sequential task_numbers", () => {
    const saved = taskCounter;
    taskCounter = 0;
    try {
      const db = createTestDb();
      const agentId = randomUUID();
      insertAgent(db, agentId, "idle");

      const t1 = randomUUID();
      const t2 = randomUUID();
      insertRefinementTask(db, t1, agentId);
      insertRefinementTask(db, t2, agentId);

      const row1 = db.prepare("SELECT task_number FROM tasks WHERE id = ?").get(t1) as { task_number: string };
      const row2 = db.prepare("SELECT task_number FROM tasks WHERE id = ?").get(t2) as { task_number: string };

      assert.equal(row1.task_number, "#1");
      assert.equal(row2.task_number, "#2");
      db.close();
    } finally {
      taskCounter = saved;
    }
  });

  it("stage transition triggers fire correctly in the in-memory DB", () => {
    const db = createTestDb();
    try {
      const agentId = randomUUID();
      const taskId = randomUUID();
      insertAgent(db, agentId, "working");
      taskCounter = 0;
      insertRefinementTask(db, taskId, agentId);

      db.prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?").run(Date.now(), taskId);
      db.prepare("UPDATE tasks SET status = 'refinement', updated_at = ? WHERE id = ?").run(Date.now(), taskId);

      const transitions = getTransitions(db, taskId);
      assert.deepEqual(transitions, [
        "__STAGE_TRANSITION__:refinement→inbox",
        "__STAGE_TRANSITION__:inbox→refinement",
      ]);
    } finally {
      db.close();
    }
  });
});

describe("POST /tasks/:id/feedback error cases", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
  });

  it("returns 404 for a non-existent task", async () => {
    const db = createTestDb();
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 }) as never,
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${randomUUID()}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Some feedback." }),
      });
      assert.equal(response.status, 404);
      const body = await response.json() as { error: string };
      assert.equal(body.error, "not_found");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns 400 for empty content", async () => {
    const db = createTestDb();
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 }) as never,
    });

    try {
      const agentId = randomUUID();
      const taskId = randomUUID();
      insertAgent(db, agentId, "idle");
      taskCounter = 0;
      insertRefinementTask(db, taskId, agentId);

      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      assert.equal(response.status, 400);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns restarted:false when task has no assigned agent and agent is idle", async () => {
    const db = createTestDb();

    const taskId = randomUUID();
    const now = Date.now();
    taskCounter = 0;
    taskCounter += 1;
    db.prepare(
      `INSERT INTO tasks (id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'refinement', 'medium', ?, ?, ?)`,
    ).run(taskId, "No agent task", "desc", `#${taskCounter}`, now, now);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        spawnCalls += 1;
        return { pid: 0 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Feedback for unassigned task." }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0, "should not attempt spawn without an assigned agent");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback refinement regressions", () => {
  before(() => {
    taskCounter = 0;
  });

  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
  });

  it("records one refinement round-trip when an active child process is restarted", async () => {
    const db = createTestDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId);

    let queueCalls = 0;
    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => {
        queueCalls += 1;
        return true;
      },
      spawnAgent: async () => {
        spawnCalls += 1;
        throw new Error("spawnAgent should not run when feedback restart stays in-process");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
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
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not duplicate transitions when feedback falls through to idle-agent respawn", async () => {
    const db = createTestDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    let spawnCalls = 0;
    let spawnedTaskStatus: string | undefined;
    let spawnedPreviousStatus: string | undefined;
    let spawnedPrompt: string | undefined;
    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task, options) => {
        spawnCalls += 1;
        spawnedTaskStatus = task.status;
        spawnedPreviousStatus = options?.previousStatus;
        spawnedPrompt = options?.continuePrompt;
        return { pid: 1234 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
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
        events.some((event) => event.type === "task_update"),
        "expected a task_update broadcast for the respawned refinement task",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
