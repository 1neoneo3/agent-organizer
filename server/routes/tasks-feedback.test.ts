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

function insertRefinementTask(db: DatabaseSync, taskId: string, agentId: string | null, completedAt?: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, completed_at, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'refinement', ?, 'medium', ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "Refinement feedback regression", agentId, completedAt ?? null, `#${taskId.slice(0, 6)}`, now, now);
}

function getTransitions(db: DatabaseSync, taskId: string): string[] {
  return (
    db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '__STAGE_TRANSITION__:%' ORDER BY id ASC",
    ).all(taskId) as Array<{ message: string }>
  ).map((row) => row.message);
}

function insertInProgressTask(db: DatabaseSync, taskId: string, agentId: string | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'in_progress', 'medium', ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "In-progress task", agentId, `#${taskId.slice(0, 6)}`, now, now);
}

function insertDoneTask(db: DatabaseSync, taskId: string, agentId: string | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, completed_at, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'done', ?, 'medium', ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "Done task", agentId, now, `#${taskId.slice(0, 6)}`, now, now);
}

const noop = {
  queueFeedbackAndRestart: () => false,
  spawnAgent: async () => ({ pid: 0 }) as never,
};

describe("POST /tasks/:id/feedback — validation", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("returns 404 for a non-existent task", async () => {
    const db = await createDb();
    const { server, baseUrl } = await startServer(db, noop);
    try {
      const res = await fetch(`${baseUrl}/tasks/${randomUUID()}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      });
      assert.equal(res.status, 404);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "not_found");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("returns 400 when content is missing", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertInProgressTask(db, taskId, null);
    const { server, baseUrl } = await startServer(db, noop);
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("returns 400 when content is empty string", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertInProgressTask(db, taskId, null);
    const { server, baseUrl } = await startServer(db, noop);
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      assert.equal(res.status, 400);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe("POST /tasks/:id/feedback — in_progress (non-refinement)", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("restarts an active process and returns restarted: true", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertInProgressTask(db, taskId, agentId);

    let queueCalls = 0;
    let spawnCalls = 0;
    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => { queueCalls += 1; return true; },
      spawnAgent: async () => { spawnCalls += 1; return { pid: 0 } as never; },
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Fix the bug." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { sent: boolean; restarted: boolean };
      assert.equal(body.sent, true);
      assert.equal(body.restarted, true);
      assert.equal(queueCalls, 1);
      assert.equal(spawnCalls, 0);
      assert.ok(
        !events.some((e) => e.type === "task_update"),
        "non-refinement restart should not broadcast task_update",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("respawns idle agent with status reset and cleared auto_respawn_count", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertDoneTask(db, taskId, agentId);

    let spawnedTask: { status: string; completed_at: unknown; auto_respawn_count: unknown } | undefined;
    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task) => {
        spawnedTask = {
          status: task.status,
          completed_at: task.completed_at,
          auto_respawn_count: task.auto_respawn_count,
        };
        return { pid: 1234 } as never;
      },
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rework this." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnedTask?.status, "in_progress");
      assert.equal(spawnedTask?.completed_at, null);
      assert.equal(spawnedTask?.auto_respawn_count, 0);
      assert.ok(
        events.some((e) => e.type === "task_update"),
        "non-refinement idle respawn should broadcast task_update for status change to in_progress",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe("POST /tasks/:id/feedback — agent edge cases", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("returns restarted: false when task has no assigned agent", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertDoneTask(db, taskId, null);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { spawnCalls += 1; return { pid: 0 } as never; },
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Agent needed." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("returns restarted: false when assigned agent is not found in DB", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertDoneTask(db, taskId, agentId);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { spawnCalls += 1; return { pid: 0 } as never; },
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Check this." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("returns restarted: false when agent status is working", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertDoneTask(db, taskId, agentId);

    let spawnCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { spawnCalls += 1; return { pid: 0 } as never; },
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Update status." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe("POST /tasks/:id/feedback — refinement agent edge cases", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("broadcasts task_update when refinement task has no assigned agent", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertRefinementTask(db, taskId, null, Date.now());

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 }) as never,
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise plan." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.ok(
        events.some((e) => e.type === "task_update"),
        "refinement with no agent should still broadcast task_update",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("broadcasts task_update when refinement agent is already working", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId, Date.now());

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 }) as never,
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Adjust criteria." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.ok(
        events.some((e) => e.type === "task_update"),
        "refinement with working agent should still broadcast task_update",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe("POST /tasks/:id/feedback — spawn failure handling", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("returns restarted: true even when spawn fails asynchronously", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertDoneTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { throw new Error("spawn failed"); },
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Try again." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, true, "response is sent before spawn completes");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

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

describe("POST /tasks/:id/feedback — completed refinement + idle agent respawn", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("performs inbox round-trip transition and respawns when completed refinement has idle agent", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId, Date.now());

    let spawnCalls = 0;
    let spawnedTaskStatus: string | undefined;
    let spawnedPrompt: string | undefined;
    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task, options) => {
        spawnCalls += 1;
        spawnedTaskStatus = task.status;
        spawnedPrompt = options?.continuePrompt;
        return { pid: 42 } as never;
      },
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise acceptance criteria." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls, 1);
      assert.equal(spawnedTaskStatus, "refinement");
      assert.equal(spawnedPrompt, "Revise acceptance criteria.");
      assert.deepEqual(getTransitions(db, taskId), [
        "__STAGE_TRANSITION__:refinement→inbox",
        "__STAGE_TRANSITION__:inbox→refinement",
      ]);
      assert.ok(
        events.some((e) => e.type === "task_update"),
        "completed refinement idle respawn should broadcast task_update",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe("POST /tasks/:id/feedback — in_progress fall-through to idle agent", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("respawns idle agent when in_progress process already exited", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertInProgressTask(db, taskId, agentId);

    let spawnedTask: { status: string; completed_at: unknown; auto_respawn_count: unknown } | undefined;
    let spawnedPrompt: string | undefined;
    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task, options) => {
        spawnedTask = {
          status: task.status,
          completed_at: task.completed_at,
          auto_respawn_count: task.auto_respawn_count,
        };
        spawnedPrompt = options?.continuePrompt;
        return { pid: 99 } as never;
      },
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Please fix the edge case." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnedTask?.status, "in_progress");
      assert.equal(spawnedTask?.completed_at, null);
      assert.equal(spawnedTask?.auto_respawn_count, 0);
      assert.equal(spawnedPrompt, "Please fix the edge case.");
      assert.ok(
        events.some((e) => e.type === "task_update"),
        "in_progress fall-through should broadcast task_update",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("returns restarted: false when in_progress has no assigned agent and process exited", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertInProgressTask(db, taskId, null);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { throw new Error("should not be called"); },
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "No agent here." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe("POST /tasks/:id/feedback — running refinement fall-through edge cases", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("does not duplicate transitions when running refinement falls through to working agent", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { throw new Error("should not be called for working agent"); },
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
      assert.deepEqual(getTransitions(db, taskId), [
        "__STAGE_TRANSITION__:refinement→inbox",
        "__STAGE_TRANSITION__:inbox→refinement",
      ], "should record exactly one round-trip even though agent was working");
      assert.ok(
        events.some((e) => e.type === "task_update"),
        "running refinement with working agent should broadcast task_update",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("does not duplicate transitions when running refinement falls through to missing agent", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => { throw new Error("should not be called for missing agent"); },
    });

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Agent gone." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { restarted: boolean };
      assert.equal(body.restarted, false);
      assert.deepEqual(getTransitions(db, taskId), [
        "__STAGE_TRANSITION__:refinement→inbox",
        "__STAGE_TRANSITION__:inbox→refinement",
      ], "should record exactly one round-trip even though agent was missing");
      assert.ok(
        events.some((e) => e.type === "task_update"),
        "running refinement with missing agent should broadcast task_update",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe("POST /tasks/:id/feedback — side effects verification", () => {
  afterEach(() => {
    rmSync(join("data", "feedback"), { recursive: true, force: true });
    rmSync(TEST_DB_PATH, { force: true });
  });

  it("creates feedback file and saves directive message to DB", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertInProgressTask(db, taskId, null);

    const { server, baseUrl } = await startServer(db, noop);

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Ship it faster." }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { feedback_path: string };

      const { existsSync, readFileSync } = await import("node:fs");
      assert.ok(existsSync(body.feedback_path), "feedback file should exist");
      const fileContent = readFileSync(body.feedback_path, "utf-8");
      assert.ok(fileContent.includes("Ship it faster."), "feedback file should contain the directive");
      assert.ok(fileContent.includes("CEO Feedback"), "feedback file should have CEO Feedback header");

      const msg = db.prepare(
        "SELECT content, message_type FROM messages WHERE task_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(taskId) as { content: string; message_type: string } | undefined;
      assert.ok(msg, "directive message should be saved");
      assert.equal(msg?.content, "Ship it faster.");
      assert.equal(msg?.message_type, "directive");

      const log = db.prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '[CEO Feedback]%' LIMIT 1"
      ).get(taskId) as { message: string } | undefined;
      assert.ok(log, "system log should be created");
      assert.ok(log?.message.includes("Ship it faster."), "log should contain feedback content");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("marks refinement_revision_requested_at for refinement feedback", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertRefinementTask(db, taskId, null, Date.now());

    const { server, baseUrl } = await startServer(db, noop);

    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rethink approach." }),
      });
      assert.equal(res.status, 200);

      const row = db.prepare(
        "SELECT refinement_revision_requested_at, refinement_revision_completed_at FROM tasks WHERE id = ?"
      ).get(taskId) as { refinement_revision_requested_at: number | null; refinement_revision_completed_at: number | null };
      assert.ok(row.refinement_revision_requested_at !== null, "refinement_revision_requested_at should be set");
      assert.equal(row.refinement_revision_completed_at, null, "refinement_revision_completed_at should be cleared");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});
