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

function insertRefinementTask(db: DatabaseSync, taskId: string, agentId: string | null, opts?: { completed_at?: number }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, 'refinement', 'medium', ?, ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "Refinement feedback regression", agentId, `#${taskId.slice(0, 6)}`, now, now, opts?.completed_at ?? null);
}

function insertTask(db: DatabaseSync, taskId: string, agentId: string, status: string, opts?: { auto_respawn_count?: number }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at, auto_respawn_count
    ) VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "Feedback test", agentId, status, `#${taskId.slice(0, 6)}`, now, now, opts?.auto_respawn_count ?? 0);
}

function forceAssignedAgentId(db: DatabaseSync, taskId: string, agentId: string): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.prepare("UPDATE tasks SET assigned_agent_id = ? WHERE id = ?").run(agentId, taskId);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function getTransitions(db: DatabaseSync, taskId: string): string[] {
  return (
    db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '__STAGE_TRANSITION__:%' ORDER BY id ASC",
    ).all(taskId) as Array<{ message: string }>
  ).map((row) => row.message);
}

function getRefinementRevisionRow(db: DatabaseSync, taskId: string): {
  refinement_revision_requested_at: number | null;
  refinement_revision_completed_at: number | null;
} {
  return db.prepare(
    "SELECT refinement_revision_requested_at, refinement_revision_completed_at FROM tasks WHERE id = ?",
  ).get(taskId) as {
    refinement_revision_requested_at: number | null;
    refinement_revision_completed_at: number | null;
  };
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

  it("skips running-process block and transitions via idle-agent path when completed_at is set", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    const completedAt = Date.now() - 60_000;
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId, { completed_at: completedAt });

    let queueCalls = 0;
    let spawnCalls = 0;
    let spawnedPrompt: string | undefined;
    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => {
        queueCalls += 1;
        return true;
      },
      spawnAgent: async (_db, _ws, _agent, _task, options) => {
        spawnCalls += 1;
        spawnedPrompt = options?.continuePrompt;
        return { pid: 2001 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rewrite the acceptance criteria." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(queueCalls, 0, "running-process block must be skipped when completed_at is set");
      assert.equal(spawnCalls, 1, "idle-agent path must spawn a new process");
      assert.equal(spawnedPrompt, "Rewrite the acceptance criteria.");
      assert.deepEqual(getTransitions(db, taskId), [
        "__STAGE_TRANSITION__:refinement→inbox",
        "__STAGE_TRANSITION__:inbox→refinement",
      ]);

      const row = db.prepare("SELECT completed_at FROM tasks WHERE id = ?").get(taskId) as { completed_at: number | null };
      assert.equal(row.completed_at, null, "completed_at must be cleared during inbox transition");

      assert.ok(
        events.some((e) => e.type === "task_update"),
        "expected task_update broadcast for completed refinement respawn",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("resets status to in_progress and clears auto_respawn_count for a done task", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "done", { auto_respawn_count: 3 });

    let spawnCalls = 0;
    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        spawnCalls += 1;
        return { pid: 3001 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rework this task from scratch." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls, 1);

      const row = db.prepare("SELECT status, auto_respawn_count FROM tasks WHERE id = ?").get(taskId) as {
        status: string;
        auto_respawn_count: number;
      };
      assert.equal(row.status, "in_progress", "done task must be reset to in_progress");
      assert.equal(row.auto_respawn_count, 0, "auto_respawn_count must be cleared");

      assert.ok(
        events.some((e) => e.type === "task_update" && (e.payload as { status: string }).status === "in_progress"),
        "expected task_update broadcast with in_progress status",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("broadcasts task_update with revision timestamps when refinement task has no agent", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    const completedAt = Date.now() - 60_000;
    insertRefinementTask(db, taskId, null, { completed_at: completedAt });

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        throw new Error("spawnAgent must not be called when no agent assigned");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Add more detail." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false, "cannot restart without an assigned agent");

      assert.ok(
        events.some((e) => e.type === "task_update"),
        "expected task_update broadcast even without agent (revision timestamps updated)",
      );
      assert.deepEqual(getTransitions(db, taskId), [], "no-agent no-op path must not log stage transitions");

      const row = getRefinementRevisionRow(db, taskId);
      assert.ok(row.refinement_revision_requested_at !== null, "revision_requested_at must be stamped");
      assert.equal(row.refinement_revision_completed_at, null, "revision_completed_at must stay cleared while awaiting revision");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("broadcasts task_update with revision timestamps when assigned agent row is missing", async () => {
    const db = await createDb();
    const existingAgentId = randomUUID();
    const missingAgentId = randomUUID();
    const taskId = randomUUID();
    const completedAt = Date.now() - 60_000;
    insertAgent(db, existingAgentId, "idle");
    insertRefinementTask(db, taskId, existingAgentId, { completed_at: completedAt });
    forceAssignedAgentId(db, taskId, missingAgentId);

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        throw new Error("spawnAgent must not be called when assigned agent row is missing");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Update the rollout plan." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false, "cannot restart when assigned agent row is missing");

      assert.ok(
        events.some((e) => e.type === "task_update"),
        "expected task_update broadcast even when assigned agent row is missing",
      );
      assert.deepEqual(getTransitions(db, taskId), [], "missing-agent no-op path must not log stage transitions");

      const row = getRefinementRevisionRow(db, taskId);
      assert.ok(row.refinement_revision_requested_at !== null, "revision_requested_at must be stamped");
      assert.equal(row.refinement_revision_completed_at, null, "revision_completed_at must stay cleared while awaiting revision");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns 404 for a non-existent task", async () => {
    const db = await createDb();
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        throw new Error("spawnAgent must not be called for non-existent task");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/does-not-exist/feedback`, {
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

  it("returns 400 when content is missing or empty", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertRefinementTask(db, taskId, null);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        throw new Error("spawnAgent must not be called for invalid body");
      },
    });

    try {
      const noContent = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(noContent.status, 400, "missing content should return 400");

      const emptyContent = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      assert.equal(emptyContent.status, 400, "empty string content should return 400");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("restarts in_progress (non-refinement) task via running process without transition logs", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "in_progress");

    let queueCalls = 0;
    let spawnCalls = 0;
    const { server, baseUrl, events } = await startServer(db, {
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
        body: JSON.stringify({ content: "Speed up the implementation." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(queueCalls, 1);
      assert.equal(spawnCalls, 0);
      assert.deepEqual(getTransitions(db, taskId), [], "non-refinement tasks must not log stage transitions");
      assert.ok(
        !events.some((e) => e.type === "task_update"),
        "non-refinement running restart must not broadcast task_update",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("falls through to idle-agent spawn when in_progress process has already exited", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "in_progress");

    let spawnCalls = 0;
    let spawnedPrompt: string | undefined;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, _task, options) => {
        spawnCalls += 1;
        spawnedPrompt = options?.continuePrompt;
        return { pid: 4001 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Continue where you left off." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls, 1);
      assert.equal(spawnedPrompt, "Continue where you left off.");
      assert.deepEqual(getTransitions(db, taskId), [], "non-refinement fall-through must not log stage transitions");

      const row = db.prepare("SELECT status, auto_respawn_count FROM tasks WHERE id = ?").get(taskId) as {
        status: string;
        auto_respawn_count: number;
      };
      assert.equal(row.status, "in_progress", "in_progress status must be preserved");
      assert.equal(row.auto_respawn_count, 0, "auto_respawn_count must be reset to 0");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("skips duplicate transition when refinementTransitionDone is already true from running-process path", async () => {
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
        return { pid: 5001 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Revise the plan completely." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls, 1);

      const transitions = getTransitions(db, taskId);
      assert.equal(transitions.length, 2, "exactly one round-trip (2 transitions), no duplicates");
      assert.deepEqual(transitions, [
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

  it("broadcasts task_update when refinement task agent is busy", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    const completedAt = Date.now() - 60_000;
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId, { completed_at: completedAt });

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        throw new Error("spawnAgent must not be called when agent is busy");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Simplify the approach." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, false, "cannot restart when agent is working on another task");

      assert.ok(
        events.some((e) => e.type === "task_update"),
        "expected task_update broadcast even when agent is busy (revision timestamps updated)",
      );
      assert.deepEqual(getTransitions(db, taskId), [], "busy-agent no-op path must not log stage transitions");

      const row = getRefinementRevisionRow(db, taskId);
      assert.ok(row.refinement_revision_requested_at !== null, "revision_requested_at must be stamped");
      assert.equal(row.refinement_revision_completed_at, null, "revision_completed_at must stay cleared while awaiting revision");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
