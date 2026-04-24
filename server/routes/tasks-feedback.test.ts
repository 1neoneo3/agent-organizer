import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, rmSync } from "node:fs";
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

function insertTask(
  db: DatabaseSync,
  taskId: string,
  agentId: string | null,
  status: string,
  opts?: { completedAt?: number },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, ?, ?)`,
  ).run(
    taskId,
    `Task ${taskId}`,
    "Feedback test task",
    agentId,
    status,
    `#${taskId.slice(0, 6)}`,
    now,
    now,
    opts?.completedAt ?? null,
  );
}

function insertRefinementTask(db: DatabaseSync, taskId: string, agentId: string): void {
  insertTask(db, taskId, agentId, "refinement");
}

function getTransitions(db: DatabaseSync, taskId: string): string[] {
  return (
    db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '__STAGE_TRANSITION__:%' ORDER BY id ASC",
    ).all(taskId) as Array<{ message: string }>
  ).map((row) => row.message);
}

function noopDeps(): Parameters<typeof createTasksRouter>[1] {
  return {
    queueFeedbackAndRestart: () => false,
    spawnAgent: async () => ({ pid: 9999 }) as never,
  };
}

// ─── Status guard tests ─────────────────────────────────────────────

describe("POST /tasks/:id/feedback status guards", () => {
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

  it("rejects feedback on a done task with 409", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "done", { completedAt: Date.now() });

    const { server, baseUrl } = await startServer(db, noopDeps());
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "This should be rejected." }),
      });
      assert.equal(res.status, 409);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "invalid_status");
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });

  it("rejects feedback on a cancelled task with 409", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "cancelled", { completedAt: Date.now() });

    const { server, baseUrl } = await startServer(db, noopDeps());
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "This should be rejected." }),
      });
      assert.equal(res.status, 409);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "invalid_status");
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });

  it("rejects feedback on an inbox task with 409", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "inbox");

    const { server, baseUrl } = await startServer(db, noopDeps());
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "This should be rejected." }),
      });
      assert.equal(res.status, 409);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "invalid_status");
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });

  it("does not write feedback file or logs for rejected statuses", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "done", { completedAt: Date.now() });

    const { server, baseUrl } = await startServer(db, noopDeps());
    try {
      await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Ghost feedback." }),
      });

      const logs = db.prepare(
        "SELECT COUNT(*) AS cnt FROM task_logs WHERE task_id = ? AND message LIKE '%CEO Feedback%'",
      ).get(taskId) as { cnt: number };
      assert.equal(logs.cnt, 0, "no feedback log should be written for rejected status");

      const msgs = db.prepare(
        "SELECT COUNT(*) AS cnt FROM messages WHERE task_id = ?",
      ).get(taskId) as { cnt: number };
      assert.equal(msgs.cnt, 0, "no message row should be created for rejected status");

      const feedbackFile = join("data", "feedback", `${taskId}.md`);
      assert.equal(existsSync(feedbackFile), false, "feedback file should not be created for rejected status");
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });

  it("allows feedback on in_progress tasks", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "in_progress");

    const { server, baseUrl } = await startServer(db, noopDeps());
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Keep going." }),
      });
      assert.equal(res.status, 200);
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });

  it("allows feedback on human_review tasks", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "human_review");

    let spawnedPreviousStatus: string | undefined;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, _task, options) => {
        spawnedPreviousStatus = options?.previousStatus;
        return { pid: 1234 } as never;
      },
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Needs rework on error handling." }),
      });
      assert.equal(res.status, 200);
      assert.equal(spawnedPreviousStatus, "human_review");

      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      assert.equal(task.status, "in_progress", "human_review task should be moved to in_progress after feedback");
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });
});

// ─── No-agent / busy-agent edge cases ────────────────────────────────

describe("POST /tasks/:id/feedback agent edge cases", () => {
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

  it("returns restarted=false when task has no assigned agent", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "in_progress");

    const { server, baseUrl } = await startServer(db, noopDeps());
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "No agent assigned." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });

  it("returns restarted=false when assigned agent is busy (working)", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "human_review");

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        throw new Error("should not spawn when agent is working");
      },
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Agent is busy." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });
});

// ─── Refinement feedback regressions ─────────────────────────────────

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

  it("stamps refinement_revision_requested_at on refinement feedback", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, noopDeps());
    try {
      const before = Date.now();
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Add more detail." }),
      });
      assert.equal(res.status, 200);

      const task = db.prepare(
        "SELECT refinement_revision_requested_at, refinement_revision_completed_at FROM tasks WHERE id = ?",
      ).get(taskId) as { refinement_revision_requested_at: number | null; refinement_revision_completed_at: number | null };

      assert.ok(task.refinement_revision_requested_at !== null, "should stamp requested_at");
      assert.ok(task.refinement_revision_requested_at! >= before, "requested_at should be recent");
      assert.equal(task.refinement_revision_completed_at, null, "completed_at should be cleared");
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });

  it("uses idle-agent path for completed refinement tasks (completed_at set)", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "refinement", { completedAt: Date.now() - 60000 });

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => {
        throw new Error("should not call queueFeedbackAndRestart for completed refinement");
      },
      spawnAgent: async () => {
        spawnCalls += 1;
        return { pid: 5678 } as never;
      },
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise completed refinement." }),
      });
      assert.equal(res.status, 200);
      assert.equal(spawnCalls, 1, "should spawn via idle-agent path");
      assert.deepEqual(getTransitions(db, taskId), [
        "__STAGE_TRANSITION__:refinement→inbox",
        "__STAGE_TRANSITION__:inbox→refinement",
      ]);
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });

  it("does not stamp refinement_revision_requested_at for in_progress feedback", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "in_progress");

    const { server, baseUrl } = await startServer(db, noopDeps());
    try {
      await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Speed up." }),
      });

      const task = db.prepare(
        "SELECT refinement_revision_requested_at FROM tasks WHERE id = ?",
      ).get(taskId) as { refinement_revision_requested_at: number | null };
      assert.equal(task.refinement_revision_requested_at, null, "should not stamp for non-refinement");
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });

  it("resets auto_respawn_count to 0 for in_progress idle-agent feedback", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "in_progress");
    db.prepare("UPDATE tasks SET auto_respawn_count = 3 WHERE id = ?").run(taskId);

    const { server, baseUrl } = await startServer(db, noopDeps());
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Try a different approach." }),
      });
      assert.equal(res.status, 200);

      const task = db.prepare(
        "SELECT auto_respawn_count FROM tasks WHERE id = ?",
      ).get(taskId) as { auto_respawn_count: number };
      assert.equal(task.auto_respawn_count, 0, "auto_respawn_count should be reset to 0");
    } finally {
      db.close();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
    }
  });
});
