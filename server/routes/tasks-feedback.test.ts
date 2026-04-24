import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
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

function insertTask(
  db: DatabaseSync,
  taskId: string,
  agentId: string | null,
  status: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "Feedback regression", agentId, status, `#${taskId.slice(0, 6)}`, now, now);
}

function getRevisionTimestamps(db: DatabaseSync, taskId: string) {
  return db.prepare(
    "SELECT refinement_revision_requested_at, refinement_revision_completed_at FROM tasks WHERE id = ?",
  ).get(taskId) as {
    refinement_revision_requested_at: number | null;
    refinement_revision_completed_at: number | null;
  };
}

function getTaskStatus(db: DatabaseSync, taskId: string): string {
  const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
  return row.status;
}

function getAutoRespawnCount(db: DatabaseSync, taskId: string): number {
  const row = db.prepare("SELECT auto_respawn_count FROM tasks WHERE id = ?").get(taskId) as { auto_respawn_count: number };
  return row.auto_respawn_count;
}

function getDirectiveMessages(db: DatabaseSync, taskId: string): Array<{ content: string }> {
  return db.prepare(
    "SELECT content FROM messages WHERE task_id = ? AND message_type = 'directive' ORDER BY created_at ASC",
  ).all(taskId) as Array<{ content: string }>;
}

function getCeoFeedbackLogs(db: DatabaseSync, taskId: string): Array<{ message: string }> {
  return db.prepare(
    "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '[CEO Feedback]%' ORDER BY id ASC",
  ).all(taskId) as Array<{ message: string }>;
}

function insertCompletedRefinementTask(db: DatabaseSync, taskId: string, agentId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'refinement', 'medium', ?, ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "Completed refinement", agentId, `#${taskId.slice(0, 6)}`, now - 1000, now, now);
}

const noopDeps = {
  queueFeedbackAndRestart: () => false,
  spawnAgent: async () => ({ pid: 0 } as never),
};

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
});

describe("POST /tasks/:id/feedback — in_progress task paths", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("restarts via queueFeedbackAndRestart for an in_progress task with no stage transitions", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "in_progress");

    let queueCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => { queueCalls += 1; return true; },
      spawnAgent: async () => { throw new Error("should not spawn"); },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Fix the edge case." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(queueCalls, 1);
      assert.deepEqual(getTransitions(db, taskId), []);

      const ts = getRevisionTimestamps(db, taskId);
      assert.equal(ts.refinement_revision_requested_at, null);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("falls through to idle-agent respawn when process is dead, resets status to in_progress", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "in_progress");

    let spawnedPreviousStatus: string | undefined;
    let spawnedPrompt: string | undefined;
    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, _task, options) => {
        spawnedPreviousStatus = options?.previousStatus;
        spawnedPrompt = options?.continuePrompt;
        return { pid: 2222 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Try another approach." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnedPreviousStatus, "in_progress");
      assert.equal(spawnedPrompt, "Try another approach.");
      assert.equal(getTaskStatus(db, taskId), "in_progress");
      assert.deepEqual(getTransitions(db, taskId), []);
      assert.ok(
        events.some((e) => e.type === "task_update"),
        "expected task_update broadcast for in_progress respawn",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — edge cases", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("returns 404 for a non-existent task", async () => {
    const db = await createDb();
    const { server, baseUrl } = await startServer(db, noopDeps);

    try {
      const response = await fetch(`${baseUrl}/tasks/${randomUUID()}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Hello" }),
      });
      assert.equal(response.status, 404);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns 400 for missing content", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "in_progress");
    const { server, baseUrl } = await startServer(db, noopDeps);

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 400);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("saves feedback but does not restart when task has no assigned agent", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "in_progress");

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { throw new Error("should not spawn"); },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Update the approach." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false);

      const msgRow = db.prepare(
        "SELECT content FROM messages WHERE task_id = ? AND message_type = 'directive'",
      ).get(taskId) as { content: string } | undefined;
      assert.ok(msgRow, "feedback should be persisted as a message");
      assert.equal(msgRow!.content, "Update the approach.");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("saves feedback but does not restart when assigned agent is busy (working)", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "done");

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { throw new Error("should not spawn"); },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revisit this." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — refinement revision timestamps", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("stamps refinement_revision_requested_at and clears completed_at on refinement feedback", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => true,
      spawnAgent: async () => ({ pid: 0 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Add error handling." }),
      });
      assert.equal(response.status, 200);

      const ts = getRevisionTimestamps(db, taskId);
      assert.ok(
        ts.refinement_revision_requested_at !== null,
        "refinement_revision_requested_at should be set",
      );
      assert.equal(
        ts.refinement_revision_completed_at,
        null,
        "refinement_revision_completed_at should be cleared",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("re-requests revision when a previously completed revision gets new feedback", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId);

    db.prepare(
      `UPDATE tasks
       SET refinement_revision_requested_at = 1000,
           refinement_revision_completed_at = 2000
       WHERE id = ?`,
    ).run(taskId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => true,
      spawnAgent: async () => ({ pid: 0 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Actually, change the approach entirely." }),
      });
      assert.equal(response.status, 200);

      const ts = getRevisionTimestamps(db, taskId);
      assert.ok(
        ts.refinement_revision_requested_at! > 2000,
        "requested_at should be newer than the previous completed_at",
      );
      assert.equal(
        ts.refinement_revision_completed_at,
        null,
        "completed_at should be cleared for the new revision cycle",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("broadcasts task_update with revision timestamps for refinement feedback", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise plan scope." }),
      });
      assert.equal(response.status, 200);

      const taskUpdates = events.filter(
        (e) => e.type === "task_update" && (e.payload as Record<string, unknown>).id === taskId,
      );
      assert.ok(taskUpdates.length > 0, "should broadcast task_update for this task");

      const payload = taskUpdates[taskUpdates.length - 1].payload as Record<string, unknown>;
      assert.ok(
        payload.refinement_revision_requested_at !== null && payload.refinement_revision_requested_at !== undefined,
        "broadcast payload should include refinement_revision_requested_at",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — completed refinement task", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("skips running-process block and transitions via idle-agent path when completed_at is set", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertCompletedRefinementTask(db, taskId, agentId);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => { throw new Error("should not attempt in-process restart for completed refinement"); },
      spawnAgent: async () => { spawnCalls += 1; return { pid: 0 } as never; },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise the completed refinement." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls, 1);
      assert.deepEqual(getTransitions(db, taskId), [
        "__STAGE_TRANSITION__:refinement→inbox",
        "__STAGE_TRANSITION__:inbox→refinement",
      ]);
      const ts = getRevisionTimestamps(db, taskId);
      assert.ok(ts.refinement_revision_requested_at !== null, "should stamp revision requested_at");
      assert.equal(ts.refinement_revision_completed_at, null, "should clear completed_at");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("stamps revision state and broadcasts task_update when a completed refinement task has no assigned agent", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "refinement");
    db.prepare("UPDATE tasks SET completed_at = ? WHERE id = ?").run(Date.now() - 1000, taskId);

    const { server, baseUrl, events } = await startServer(db, noopDeps);

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise again without an assignee." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.deepEqual(getTransitions(db, taskId), []);

      const ts = getRevisionTimestamps(db, taskId);
      assert.ok(ts.refinement_revision_requested_at !== null, "should stamp revision requested_at");
      assert.equal(ts.refinement_revision_completed_at, null, "should clear completed_at");

      const taskUpdates = events.filter(
        (e) => e.type === "task_update" && (e.payload as Record<string, unknown>).id === taskId,
      );
      assert.ok(taskUpdates.length > 0, "should broadcast task_update for completed refinement without agent");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("stamps revision state and broadcasts task_update when a completed refinement task's agent is busy", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "refinement");
    db.prepare("UPDATE tasks SET completed_at = ? WHERE id = ?").run(Date.now() - 1000, taskId);

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { throw new Error("should not spawn"); },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise again while the agent is busy." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.deepEqual(getTransitions(db, taskId), []);

      const ts = getRevisionTimestamps(db, taskId);
      assert.ok(ts.refinement_revision_requested_at !== null, "should stamp revision requested_at");
      assert.equal(ts.refinement_revision_completed_at, null, "should clear completed_at");

      const taskUpdates = events.filter(
        (e) => e.type === "task_update" && (e.payload as Record<string, unknown>).id === taskId,
      );
      assert.ok(taskUpdates.length > 0, "should broadcast task_update for completed refinement with busy agent");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — done task idle-agent respawn", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("resets status to in_progress and clears auto_respawn_count for a done task", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "done");

    db.prepare("UPDATE tasks SET auto_respawn_count = 3 WHERE id = ?").run(taskId);

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Reopen and fix this." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(getTaskStatus(db, taskId), "in_progress");
      assert.equal(getAutoRespawnCount(db, taskId), 0);
      assert.deepEqual(getTransitions(db, taskId), [
        "__STAGE_TRANSITION__:done→in_progress",
      ]);
      assert.ok(
        events.some((e) => e.type === "task_update" && (e.payload as Record<string, unknown>).status === "in_progress"),
        "should broadcast task_update with in_progress status",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("persists feedback without reopening when a done task has no assigned agent", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "done");

    const { server, baseUrl } = await startServer(db, noopDeps);

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Leave this done task parked." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.equal(getTaskStatus(db, taskId), "done");
      assert.equal(getAutoRespawnCount(db, taskId), 0);
      assert.deepEqual(getTransitions(db, taskId), []);

      const messages = getDirectiveMessages(db, taskId);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.content, "Leave this done task parked.");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — persistence and broadcasts", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("returns 400 for empty string content", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "in_progress");
    const { server, baseUrl } = await startServer(db, noopDeps);

    try {
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

  it("persists feedback file, directive message, and CEO log entry", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "in_progress");

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => true,
      spawnAgent: async () => ({ pid: 0 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Please add input validation." }),
      });
      assert.equal(response.status, 200);

      const feedbackPath = join("data", "feedback", `${taskId}.md`);
      assert.ok(existsSync(feedbackPath), "feedback file should exist");
      const fileContent = readFileSync(feedbackPath, "utf-8");
      assert.ok(fileContent.includes("CEO Feedback"), "file should contain CEO Feedback header");
      assert.ok(fileContent.includes("Please add input validation."), "file should contain the feedback content");

      const messages = getDirectiveMessages(db, taskId);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, "Please add input validation.");

      const logs = getCeoFeedbackLogs(db, taskId);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].message, "[CEO Feedback] Please add input validation.");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("broadcasts message_new and cli_output events", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "in_progress");

    const { server, baseUrl, events } = await startServer(db, noopDeps);

    try {
      await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Broadcast test." }),
      });

      assert.ok(
        events.some((e) => e.type === "message_new"),
        "should broadcast message_new",
      );
      const cliOutput = events.find(
        (e) => e.type === "cli_output" && (e.payload as Record<string, unknown>).task_id === taskId,
      );
      assert.ok(cliOutput, "should broadcast cli_output for the task");
      assert.equal(
        (cliOutput!.payload as Record<string, unknown>).message,
        "[CEO Feedback] Broadcast test.",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("appends multiple feedbacks to the same file", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "in_progress");

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => true,
      spawnAgent: async () => ({ pid: 0 } as never),
    });

    try {
      await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "First feedback." }),
      });
      await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Second feedback." }),
      });

      const feedbackPath = join("data", "feedback", `${taskId}.md`);
      const fileContent = readFileSync(feedbackPath, "utf-8");
      assert.ok(fileContent.includes("First feedback."), "file should contain first feedback");
      assert.ok(fileContent.includes("Second feedback."), "file should contain second feedback");

      const messages = getDirectiveMessages(db, taskId);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].content, "First feedback.");
      assert.equal(messages[1].content, "Second feedback.");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — refinement no-agent / busy-agent broadcasts", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("broadcasts task_update with revision timestamps when refinement task has no agent", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "refinement");

    const { server, baseUrl, events } = await startServer(db, noopDeps);

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise without agent." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false);

      const ts = getRevisionTimestamps(db, taskId);
      assert.ok(ts.refinement_revision_requested_at !== null, "revision should be requested");

      const taskUpdates = events.filter(
        (e) => e.type === "task_update" && (e.payload as Record<string, unknown>).id === taskId,
      );
      assert.ok(taskUpdates.length > 0, "should broadcast task_update even without agent");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("broadcasts task_update when refinement task agent is busy", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "refinement");

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { throw new Error("should not spawn"); },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise while agent is busy." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false);

      const taskUpdates = events.filter(
        (e) => e.type === "task_update" && (e.payload as Record<string, unknown>).id === taskId,
      );
      assert.ok(taskUpdates.length > 0, "should broadcast task_update when agent is busy");

      const payload = taskUpdates[taskUpdates.length - 1].payload as Record<string, unknown>;
      assert.ok(
        payload.refinement_revision_requested_at !== null,
        "broadcast should include revision requested timestamp",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
