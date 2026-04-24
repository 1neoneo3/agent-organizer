import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { before, after, afterEach, describe, it } from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CacheService } from "../cache/cache-service.js";

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), "ao-feedback-route-"));
const TEST_DB_PATH = join(TEST_DB_DIR, "test.db");
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
  const mod = await import("../db/runtime.js");
  try {
    const prev = mod.getDb();
    prev.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    prev.close();
  } catch { /* no prior connection */ }
  rmSync(TEST_DB_PATH, { force: true });
  rmSync(`${TEST_DB_PATH}-wal`, { force: true });
  rmSync(`${TEST_DB_PATH}-shm`, { force: true });
  return mod.initializeDb();
}

async function startServer(
  db: DatabaseSync,
  deps: Parameters<typeof import("./tasks.js").createTasksRouter>[1],
): Promise<{ server: Server; baseUrl: string; events: Array<{ type: string; payload: unknown; options?: unknown }> }> {
  const { createTasksRouter } = await import("./tasks.js");
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

function getTask(db: DatabaseSync, taskId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
}

describe("POST /tasks/:id/feedback refinement regressions", () => {
  after(() => {
    rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
  });

  it("returns 404 when the task does not exist", async () => {
    const db = await createDb();
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${randomUUID()}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      });
      assert.equal(res.status, 404);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("returns 400 when content is empty", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      assert.equal(res.status, 400);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("sets refinement_revision_requested_at and clears completed_at on refinement feedback", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Please revise." }),
      });
      assert.equal(res.status, 200);
      const task = getTask(db, taskId);
      assert.ok(task);
      assert.ok(typeof task.refinement_revision_requested_at === "number");
      assert.equal(task.refinement_revision_completed_at, null);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("returns restarted: false when refinement task has no assigned agent", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    const now = Date.now();
    const taskNumber = `#${++testTaskSeq}`;
    db.prepare(
      `INSERT INTO tasks (id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'refinement', 'medium', ?, ?, ?)`,
    ).run(taskId, "No agent task", "desc", taskNumber, now, now);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        spawnCalls += 1;
        return { pid: 0 } as never;
      },
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Feedback without agent." }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("returns restarted: false when assigned agent is working", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        spawnCalls += 1;
        return { pid: 0 } as never;
      },
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Agent busy feedback." }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
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

  it("handles in_progress feedback without refinement transitions", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    const now = Date.now();
    const taskNumber = `#${++testTaskSeq}`;
    db.prepare(
      `INSERT INTO tasks (id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'in_progress', 'medium', ?, ?, ?)`,
    ).run(taskId, "In-progress task", "desc", agentId, taskNumber, now, now);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => true,
      spawnAgent: async () => {
        spawnCalls += 1;
        return { pid: 1 } as never;
      },
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Fix the bug." }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls, 0);
      const transitions = getTransitions(db, taskId);
      assert.equal(transitions.length, 0, "in_progress feedback should not log refinement transitions");
      const task = getTask(db, taskId);
      assert.ok(task);
      assert.equal(task.refinement_revision_requested_at, null);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("respawns idle agent with in_progress status when in_progress feedback falls through", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    const now = Date.now();
    const taskNumber = `#${++testTaskSeq}`;
    db.prepare(
      `INSERT INTO tasks (id, title, description, assigned_agent_id, status, task_size, task_number, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'done', 'medium', ?, ?, ?, ?)`,
    ).run(taskId, "Done task", "desc", agentId, taskNumber, now, now, now);

    let spawnedPrompt: string | undefined;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, _task, options) => {
        spawnedPrompt = options?.continuePrompt;
        return { pid: 1 } as never;
      },
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Reopen and fix." }),
      });
      assert.equal(res.status, 200);
      assert.equal(spawnedPrompt, "Reopen and fix.");
      const task = getTask(db, taskId);
      assert.ok(task);
      assert.equal(task.status, "in_progress");
      assert.equal(task.completed_at, null);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
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

  it("completed refinement task (completed_at set) takes idle-agent respawn path", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    const now = Date.now();
    const taskNumber = `#${++testTaskSeq}`;
    db.prepare(
      `INSERT INTO tasks (id, title, description, assigned_agent_id, status, task_size, task_number, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'refinement', 'medium', ?, ?, ?, ?)`,
    ).run(taskId, "Completed refinement", "desc", agentId, taskNumber, now, now, now);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task, options) => {
        spawnCalls += 1;
        assert.equal(task.status, "refinement");
        assert.equal(options?.previousStatus, "refinement");
        return { pid: 1 } as never;
      },
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise the completed plan." }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls, 1);

      const task = getTask(db, taskId);
      assert.ok(task);
      assert.ok(typeof task.refinement_revision_requested_at === "number");
      assert.equal(task.refinement_revision_completed_at, null);
      assert.deepEqual(getTransitions(db, taskId), [
        "__STAGE_TRANSITION__:refinement→inbox",
        "__STAGE_TRANSITION__:inbox→refinement",
      ]);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("non-refinement feedback resets auto_respawn_count and clears completed_at", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    const now = Date.now();
    const taskNumber = `#${++testTaskSeq}`;
    db.prepare(
      `INSERT INTO tasks (id, title, description, assigned_agent_id, status, task_size, task_number, completed_at, auto_respawn_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'done', 'medium', ?, ?, 3, ?, ?)`,
    ).run(taskId, "Auto-respawned task", "desc", agentId, taskNumber, now, now, now);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rework the implementation." }),
      });
      assert.equal(res.status, 200);
      const task = getTask(db, taskId);
      assert.ok(task);
      assert.equal(task.status, "in_progress");
      assert.equal(task.completed_at, null);
      assert.equal(task.auto_respawn_count, 0);
      assert.equal(task.refinement_revision_requested_at, null);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("persists feedback message in the messages table", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1 }) as never,
    });
    try {
      await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Add error handling." }),
      });
      const msgs = db.prepare(
        "SELECT content, message_type, task_id FROM messages WHERE task_id = ?",
      ).all(taskId) as Array<{ content: string; message_type: string; task_id: string }>;
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].content, "Add error handling.");
      assert.equal(msgs[0].message_type, "directive");
      assert.equal(msgs[0].task_id, taskId);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("appends feedback content to the feedback file on disk", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Check edge cases." }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { feedback_path: string };
      assert.ok(body.feedback_path);

      const { readFileSync, existsSync } = await import("node:fs");
      assert.ok(existsSync(body.feedback_path), "feedback file should exist on disk");
      const contents = readFileSync(body.feedback_path, "utf-8");
      assert.ok(contents.includes("Check edge cases."));
      assert.ok(contents.includes("CEO Feedback"));
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });
});
