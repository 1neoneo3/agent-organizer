import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function createWsRecorder(onBroadcast?: (type: string, payload: unknown, options?: unknown) => void) {
  const events: Array<{ type: string; payload: unknown; options?: unknown }> = [];
  return {
    ws: {
      broadcast(type: string, payload: unknown, options?: unknown) {
        events.push({ type, payload, options });
        onBroadcast?.(type, payload, options);
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
  options?: { onBroadcast?: (type: string, payload: unknown, options?: unknown) => void },
): Promise<{ server: Server; baseUrl: string; events: Array<{ type: string; payload: unknown; options?: unknown }> }> {
  const { ws, events } = createWsRecorder(options?.onBroadcast);
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

function insertTask(
  db: DatabaseSync,
  taskId: string,
  agentId: string | null,
  status: string,
  extra?: { completed_at?: number },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number,
      completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, ?, ?)`,
  ).run(
    taskId,
    `Task ${taskId}`,
    "Feedback test task",
    agentId,
    status,
    `#${taskId.slice(0, 6)}`,
    extra?.completed_at ?? null,
    now,
    now,
  );
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

  it("returns 409 when feedback is already in-flight for the same task", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const inFlight = new Set<string>([taskId]);
    const { server, baseUrl } = await startServer(db, {
      _feedbackInFlight: inFlight,
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Concurrent request." }),
      });
      assert.equal(response.status, 409);
      const body = await response.json() as { error: string };
      assert.equal(body.error, "feedback_in_progress");

      assert.deepEqual(getTransitions(db, taskId), []);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("transaction rolls back on DB failure — task not stuck in inbox", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    db.exec("DROP TABLE messages");

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Should fail and rollback." }),
      });
      assert.equal(response.status, 500);

      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      assert.equal(task.status, "refinement", "task must not be stuck in inbox after rollback");

      assert.deepEqual(getTransitions(db, taskId), []);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rolls back feedback file append when DB work fails", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const feedbackDir = join("data", "feedback");
    const feedbackPath = join(feedbackDir, `${taskId}.md`);
    const existingContent = "# Existing feedback\n";
    rmSync(feedbackDir, { recursive: true, force: true });
    mkdirSync(feedbackDir, { recursive: true });
    writeFileSync(feedbackPath, existingContent, "utf-8");

    db.exec("DROP TABLE messages");

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Should not leak into the file." }),
      });
      assert.equal(response.status, 500);
      assert.equal(readFileSync(feedbackPath, "utf-8"), existingContent);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("concurrency guard is released after a failed request (next request succeeds)", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    db.exec("DROP TABLE messages");

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 } as never),
    });

    try {
      const r1 = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Will fail." }),
      });
      assert.equal(r1.status, 500);

      db.exec(
        `CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, sender_type TEXT, sender_id TEXT,
          content TEXT, message_type TEXT, task_id TEXT, created_at INTEGER
        )`,
      );

      const r2 = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Should succeed after guard release." }),
      });
      assert.equal(r2.status, 200, "guard should be released after failed request");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — validation and edge cases", () => {
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

  it("returns 404 for a non-existent task", async () => {
    const db = await createDb();
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${randomUUID()}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Hello" }),
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
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "in_progress");
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 } as never),
    });

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

  it("returns 400 for whitespace-only content", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "in_progress");
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: " \n\t " }),
      });
      assert.equal(response.status, 400);
      assert.equal(existsSync(join("data", "feedback", `${taskId}.md`)), false);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns 400 when content field is missing", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "in_progress");
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 } as never),
    });

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
});

describe("POST /tasks/:id/feedback — in_progress tasks", () => {
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

  it("restarts running in_progress task via queueFeedbackAndRestart", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "in_progress");

    let queueCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => {
        queueCalls += 1;
        return true;
      },
      spawnAgent: async () => {
        throw new Error("spawnAgent should not run for running in_progress task");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Fix the bug." }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { sent: boolean; restarted: boolean };
      assert.equal(body.sent, true);
      assert.equal(body.restarted, true);
      assert.equal(queueCalls, 1);

      assert.deepEqual(getTransitions(db, taskId), [], "in_progress task should not have refinement transitions");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("respawns idle agent for in_progress task with auto_respawn_count reset", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "in_progress");
    db.prepare("UPDATE tasks SET auto_respawn_count = 3 WHERE id = ?").run(taskId);

    let spawnedTask: { status: string; auto_respawn_count: number } | undefined;
    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task) => {
        spawnedTask = { status: task.status, auto_respawn_count: task.auto_respawn_count };
        return { pid: 5678 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rework this." }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);

      assert.ok(spawnedTask, "spawnAgent should have been called");
      assert.equal(spawnedTask!.status, "in_progress");

      const task = db.prepare("SELECT auto_respawn_count FROM tasks WHERE id = ?").get(taskId) as { auto_respawn_count: number };
      assert.equal(task.auto_respawn_count, 0, "auto_respawn_count should be reset for manual feedback rework");

      assert.ok(
        events.some((e) => e.type === "task_update"),
        "expected a task_update broadcast",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — agent availability edge cases", () => {
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

  it("returns restarted: false when no agent is assigned", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "done", { completed_at: Date.now() });

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        spawnCalls += 1;
        return { pid: 1234 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Any feedback." }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns restarted: false when assigned agent is busy (working)", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "done", { completed_at: Date.now() });

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        spawnCalls += 1;
        return { pid: 1234 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Feedback with busy agent." }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — completed refinement (idle-agent path)", () => {
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

  it("completed refinement task (completed_at set) takes idle-agent respawn path", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "refinement", { completed_at: Date.now() });

    let spawnCalls = 0;
    let spawnedPreviousStatus: string | undefined;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, _task, options) => {
        spawnCalls += 1;
        spawnedPreviousStatus = options?.previousStatus;
        return { pid: 2345 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise the completed plan." }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls, 1);
      assert.equal(spawnedPreviousStatus, "refinement");

      assert.deepEqual(getTransitions(db, taskId), [
        "__STAGE_TRANSITION__:refinement→inbox",
        "__STAGE_TRANSITION__:inbox→refinement",
      ]);

      const task = db.prepare("SELECT refinement_revision_requested_at, refinement_revision_completed_at FROM tasks WHERE id = ?").get(taskId) as {
        refinement_revision_requested_at: number | null;
        refinement_revision_completed_at: number | null;
      };
      assert.ok(task.refinement_revision_requested_at, "refinement_revision_requested_at should be set");
      assert.equal(task.refinement_revision_completed_at, null, "refinement_revision_completed_at should be cleared");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — persistence checks", () => {
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

  it("persists feedback file and message in DB", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "in_progress");

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 } as never),
    });

    const feedbackContent = "Please optimize the database queries.";

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: feedbackContent }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { feedback_path: string };

      assert.ok(existsSync(body.feedback_path), "feedback file should exist");
      const fileContent = readFileSync(body.feedback_path, "utf-8");
      assert.ok(fileContent.includes(feedbackContent), "feedback file should contain the directive");
      assert.ok(fileContent.includes("CEO Feedback"), "feedback file should have CEO Feedback header");

      const msg = db.prepare(
        "SELECT content, message_type, task_id FROM messages WHERE task_id = ? AND message_type = 'directive'",
      ).get(taskId) as { content: string; message_type: string; task_id: string } | undefined;
      assert.ok(msg, "message should be persisted in DB");
      assert.equal(msg!.content, feedbackContent);
      assert.equal(msg!.task_id, taskId);

      const log = db.prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '[CEO Feedback]%'",
      ).get(taskId) as { message: string } | undefined;
      assert.ok(log, "task log should contain CEO Feedback entry");
      assert.ok(log!.message.includes(feedbackContent), "log should contain full feedback content");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("ws broadcasts happen after commit (message_new and cli_output)", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "done", { completed_at: Date.now() });

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 } as never),
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Broadcast test." }),
      });
      assert.equal(response.status, 200);

      assert.ok(
        events.some((e) => e.type === "message_new"),
        "expected message_new broadcast",
      );
      assert.ok(
        events.some((e) => e.type === "cli_output"),
        "expected cli_output broadcast",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback — done/cancelled task rework", () => {
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

  it("done task with idle agent is respawned as in_progress", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "done", { completed_at: Date.now() });

    let spawnedTaskStatus: string | undefined;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task) => {
        spawnedTaskStatus = task.status;
        return { pid: 9999 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rework this completed task." }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);

      const task = db.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(taskId) as { status: string; completed_at: number | null };
      assert.equal(task.status, "in_progress", "done task should transition to in_progress");
      assert.equal(task.completed_at, null, "completed_at should be cleared for rework");

      assert.equal(spawnedTaskStatus, "in_progress");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns 409 when task status changes after feedback is committed but before idle-agent rework", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "done", { completed_at: Date.now() });

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(
      db,
      {
        queueFeedbackAndRestart: () => false,
        spawnAgent: async () => {
          spawnCalls += 1;
          return { pid: 9999 } as never;
        },
      },
      {
        onBroadcast: (type) => {
          if (type === "message_new") {
            db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), taskId);
          }
        },
      },
    );

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rework this completed task." }),
      });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string; expected_status: string; current_status: string };
      assert.equal(body.error, "status_changed");
      assert.equal(body.expected_status, "done");
      assert.equal(body.current_status, "cancelled");
      assert.equal(spawnCalls, 0);

      const task = db.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(taskId) as { status: string; completed_at: number | null };
      assert.equal(task.status, "cancelled");
      assert.ok(task.completed_at, "completed_at should remain intact when rework is aborted");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
