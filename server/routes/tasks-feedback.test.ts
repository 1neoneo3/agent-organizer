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
import { clearPendingSpawn } from "../spawner/process-manager.js";

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

let testTaskSeq = 9000;
function insertRefinementTask(db: DatabaseSync, taskId: string, agentId: string): void {
  const now = Date.now();
  const taskNumber = `#${++testTaskSeq}`;
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'refinement', 'medium', ?, ?, ?)`,
  ).run(taskId, "Refinement feedback test task", "Refinement feedback regression", agentId, taskNumber, now, now);
}

function getTransitions(db: DatabaseSync, taskId: string): string[] {
  return (
    db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '__STAGE_TRANSITION__:%' ORDER BY id ASC",
    ).all(taskId) as Array<{ message: string }>
  ).map((row) => row.message);
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

  it("prevents concurrent feedback spawns for the same task", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    let spawnCalls = 0;
    let resolveSpawn!: () => void;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        spawnCalls += 1;
        await new Promise<void>((r) => { resolveSpawn = r; });
        return { pid: 5678 } as never;
      },
    });

    try {
      const response1 = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "First revision." }),
      });
      assert.equal(response1.status, 200);
      const body1 = await response1.json() as { restarted: boolean };
      assert.equal(body1.restarted, true);
      assert.equal(spawnCalls, 1);

      const response2 = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Second revision while first in flight." }),
      });
      assert.equal(response2.status, 200);
      const body2 = await response2.json() as { restarted: boolean };
      assert.equal(body2.restarted, false, "second spawn should be blocked by pending-spawn guard");
      assert.equal(spawnCalls, 1, "spawnAgent should only be called once");
    } finally {
      resolveSpawn();
      await new Promise((r) => setTimeout(r, 10));
      clearPendingSpawn(taskId);
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("clears pending-spawn slot after spawn failure so retries are not blocked", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        spawnCalls += 1;
        throw new Error("simulated spawn failure");
      },
    });

    try {
      const response1 = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "First attempt." }),
      });
      assert.equal(response1.status, 200);
      assert.equal(spawnCalls, 1);

      await new Promise((r) => setTimeout(r, 20));

      const response2 = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Retry after failure." }),
      });
      assert.equal(response2.status, 200);
      const body2 = await response2.json() as { restarted: boolean };
      assert.equal(body2.restarted, true, "retry should succeed after failed spawn clears the slot");
      assert.equal(spawnCalls, 2, "spawnAgent should be called again after failure");
    } finally {
      await new Promise((r) => setTimeout(r, 10));
      clearPendingSpawn(taskId);
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("allows concurrent feedback spawns for different tasks", async () => {
    const db = await createDb();
    const agentId1 = randomUUID();
    const agentId2 = randomUUID();
    const taskId1 = randomUUID();
    const taskId2 = randomUUID();
    insertAgent(db, agentId1, "idle");
    insertAgent(db, agentId2, "idle");
    insertRefinementTask(db, taskId1, agentId1);
    insertRefinementTask(db, taskId2, agentId2);

    const spawnedTasks: string[] = [];
    const resolvers: Array<() => void> = [];
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task) => {
        spawnedTasks.push(task.id);
        await new Promise<void>((r) => { resolvers.push(r); });
        return { pid: 9999 } as never;
      },
    });

    try {
      const response1 = await fetch(`${baseUrl}/tasks/${taskId1}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Task 1 feedback." }),
      });
      assert.equal(response1.status, 200);
      assert.equal((await response1.json() as { restarted: boolean }).restarted, true);

      const response2 = await fetch(`${baseUrl}/tasks/${taskId2}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Task 2 feedback." }),
      });
      assert.equal(response2.status, 200);
      assert.equal(
        (await response2.json() as { restarted: boolean }).restarted,
        true,
        "different tasks should not block each other",
      );

      assert.equal(spawnedTasks.length, 2);
      assert.ok(spawnedTasks.includes(taskId1));
      assert.ok(spawnedTasks.includes(taskId2));
    } finally {
      for (const r of resolvers) r();
      await new Promise((r) => setTimeout(r, 10));
      clearPendingSpawn(taskId1);
      clearPendingSpawn(taskId2);
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("clears pending-spawn slot after successful spawn so next feedback is not blocked", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        spawnCalls += 1;
        return { pid: 7777 } as never;
      },
    });

    try {
      const response1 = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "First revision." }),
      });
      assert.equal(response1.status, 200);
      assert.equal((await response1.json() as { restarted: boolean }).restarted, true);
      assert.equal(spawnCalls, 1);

      await new Promise((r) => setTimeout(r, 20));

      const response2 = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Second revision after first completed." }),
      });
      assert.equal(response2.status, 200);
      const body2 = await response2.json() as { restarted: boolean };
      assert.equal(body2.restarted, true, "second spawn should work after first completes");
      assert.equal(spawnCalls, 2);
    } finally {
      await new Promise((r) => setTimeout(r, 10));
      clearPendingSpawn(taskId);
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("persists feedback data even when concurrent spawn is blocked", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    let resolveSpawn!: () => void;
    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        await new Promise<void>((r) => { resolveSpawn = r; });
        return { pid: 3333 } as never;
      },
    });

    try {
      const response1 = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "First feedback." }),
      });
      assert.equal(response1.status, 200);

      const response2 = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Blocked feedback." }),
      });
      assert.equal(response2.status, 200);
      const body2 = await response2.json() as { sent: boolean; restarted: boolean };
      assert.equal(body2.sent, true, "feedback should still be recorded");
      assert.equal(body2.restarted, false, "spawn should be blocked");

      const messages = db.prepare(
        "SELECT content FROM messages WHERE task_id = ? ORDER BY created_at ASC",
      ).all(taskId) as Array<{ content: string }>;
      assert.equal(messages.length, 2, "both feedback messages should be persisted");
      assert.equal(messages[0].content, "First feedback.");
      assert.equal(messages[1].content, "Blocked feedback.");

      const logs = db.prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '%[CEO Feedback]%' ORDER BY id ASC",
      ).all(taskId) as Array<{ message: string }>;
      assert.equal(logs.length, 2, "both feedback logs should be persisted");

      const messageNewEvents = events.filter((e) => e.type === "message_new");
      assert.equal(messageNewEvents.length, 2, "both message_new events should be broadcast");
    } finally {
      resolveSpawn();
      await new Promise((r) => setTimeout(r, 10));
      clearPendingSpawn(taskId);
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
