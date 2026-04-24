import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { before, after, afterEach, describe, it } from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CacheService } from "../cache/cache-service.js";
import { createTasksRouter } from "./tasks.js";

const TEST_DB_PATH = join(tmpdir(), `ao-feedback-route-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;

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

async function createDb(): Promise<DatabaseSync> {
  const { initializeDb } = await import("../db/runtime.js");
  return initializeDb();
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

function getTaskField(db: DatabaseSync, taskId: string, field: string): unknown {
  const row = db.prepare(`SELECT ${field} FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown> | undefined;
  return row?.[field];
}

function insertInProgressTask(db: DatabaseSync, taskId: string, agentId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'in_progress', 'medium', ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "In-progress feedback test", agentId, `#${taskId.slice(0, 6)}`, now, now);
}

describe("POST /tasks/:id/feedback refinement regressions", () => {
  before(() => {
    rmSync(TEST_DB_PATH, { force: true });
  });

  after(() => {
    rmSync(TEST_DB_PATH, { force: true });
  });

  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("records one refinement round-trip when an active child process is restarted", async () => {
    const db = await createDb();
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
    const db = await createDb();
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

  it("clears completed_at when revision feedback restarts an active completed refinement", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId);
    db.prepare(
      "UPDATE tasks SET completed_at = ?, refinement_completed_at = ? WHERE id = ?",
    ).run(Date.now() - 5_000, Date.now() - 5_000, taskId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => true,
      spawnAgent: async () => ({ pid: 0 }) as never,
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rethink the approach." }),
      });
      assert.equal(response.status, 200);

      const completedAt = getTaskField(db, taskId, "completed_at");
      assert.equal(completedAt, null, "completed_at must be NULL after revision feedback");

      const revRequestedAt = getTaskField(db, taskId, "refinement_revision_requested_at");
      assert.ok(typeof revRequestedAt === "number" && revRequestedAt > 0, "refinement_revision_requested_at must be stamped");

      const revCompletedAt = getTaskField(db, taskId, "refinement_revision_completed_at");
      assert.equal(revCompletedAt, null, "refinement_revision_completed_at must be cleared");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("clears completed_at on idle-agent fallthrough for completed refinement revision", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);
    db.prepare(
      "UPDATE tasks SET completed_at = ?, refinement_completed_at = ?, refinement_plan = 'old plan' WHERE id = ?",
    ).run(Date.now() - 5_000, Date.now() - 5_000, taskId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 9999 }) as never,
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Add security considerations." }),
      });
      assert.equal(response.status, 200);

      const completedAt = getTaskField(db, taskId, "completed_at");
      assert.equal(completedAt, null, "completed_at must be NULL after idle-agent revision");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("resets an in_progress task and respawns when feedback targets a running implementation", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertInProgressTask(db, taskId, agentId);

    let spawnedPreviousStatus: string | undefined;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task, options) => {
        spawnedPreviousStatus = options?.previousStatus;
        return { pid: 5555 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Change the database schema." }),
      });
      assert.equal(response.status, 200);

      const status = getTaskField(db, taskId, "status");
      assert.equal(status, "in_progress");
      assert.equal(spawnedPreviousStatus, "in_progress");

      const autoRespawn = getTaskField(db, taskId, "auto_respawn_count");
      assert.equal(autoRespawn, 0, "auto_respawn_count must be reset on manual feedback");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns sent-only when the task has no assigned agent", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number, created_at, updated_at
      ) VALUES (?, ?, ?, 'refinement', 'medium', ?, ?, ?)`,
    ).run(taskId, `Task ${taskId}`, "No agent test", `#${taskId.slice(0, 6)}`, now, now);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        throw new Error("should not spawn");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "This should not spawn." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false, "restarted must be false when no agent is assigned");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
