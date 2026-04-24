import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync, readFileSync, existsSync } from "node:fs";
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

function insertInProgressTask(db: DatabaseSync, taskId: string, agentId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'in_progress', 'medium', ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "In-progress feedback test", agentId, `#${taskId.slice(0, 6)}`, now, now);
}

function insertCompletedRefinementTask(db: DatabaseSync, taskId: string, agentId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number,
      completed_at, refinement_completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'refinement', 'medium', ?, ?, ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "Completed refinement", agentId, `#${taskId.slice(0, 6)}`, now, now, now, now);
}

function insertUnassignedRefinementTask(db: DatabaseSync, taskId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, 'refinement', 'medium', ?, ?, ?)`,
  ).run(taskId, `Task ${taskId}`, "Unassigned refinement", `#${taskId.slice(0, 6)}`, now, now);
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
});

describe("POST /tasks/:id/feedback edge cases", () => {
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

  it("rejects empty content with 400", async () => {
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

  it("returns 404 for nonexistent task", async () => {
    const db = await createDb();
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 }) as never,
    });

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

  it("completed refinement (completed_at set) bypasses running-process branch, records transitions via idle-agent path", async () => {
    // completed_at is truthy → running-process branch skipped (refinementTransitionDone stays false)
    // → falls through to idle-agent path where !refinementTransitionDone triggers the inbox round-trip
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertCompletedRefinementTask(db, taskId, agentId);

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
        body: JSON.stringify({ content: "Post-completion feedback." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { sent: boolean; restarted: boolean };
      assert.equal(body.sent, true);
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls, 1);
      assert.deepEqual(
        getTransitions(db, taskId),
        [
          "__STAGE_TRANSITION__:refinement→inbox",
          "__STAGE_TRANSITION__:inbox→refinement",
        ],
        "idle-agent path records the round-trip when running-process path was skipped (completed_at set)",
      );
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not restart when no agent is assigned but still records transitions", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertUnassignedRefinementTask(db, taskId);

    let spawnCalls = 0;
    const { server, baseUrl, events } = await startServer(db, {
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
        body: JSON.stringify({ content: "Feedback without agent." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { sent: boolean; restarted: boolean };
      assert.equal(body.sent, true);
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0, "spawnAgent should not be called when no agent is assigned");
      assert.deepEqual(
        getTransitions(db, taskId),
        [
          "__STAGE_TRANSITION__:refinement→inbox",
          "__STAGE_TRANSITION__:inbox→refinement",
        ],
        "transitions are still recorded via the running-process path even without an agent",
      );
      const refinementUpdate = events.find(
        (event) => event.type === "task_update"
          && (event.payload as { id?: string; status?: string }).id === taskId
          && (event.payload as { id?: string; status?: string }).status === "refinement",
      );
      assert.ok(refinementUpdate, "should broadcast a refinement task_update when no agent is assigned");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("working agent: running-process path records transitions, then idle-agent path skips (agent busy)", async () => {
    // running-process branch enters (status=refinement, !completed_at) → records inbox round-trip
    // → refinementTransitionDone=true → queueFeedbackAndRestart returns false → falls through
    // → agent.status=working → early return without spawnAgent
    // Key regression check: transitions recorded exactly once despite fall-through
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertRefinementTask(db, taskId, agentId);

    let spawnCalls = 0;
    const { server, baseUrl, events } = await startServer(db, {
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
        body: JSON.stringify({ content: "Agent is busy." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { sent: boolean; restarted: boolean };
      assert.equal(body.sent, true);
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0, "spawnAgent should not be called when agent is working");
      assert.deepEqual(
        getTransitions(db, taskId),
        [
          "__STAGE_TRANSITION__:refinement→inbox",
          "__STAGE_TRANSITION__:inbox→refinement",
        ],
        "running-process path records transitions; idle-agent path skips due to refinementTransitionDone=true",
      );
      const refinementUpdate = events.find(
        (event) => event.type === "task_update"
          && (event.payload as { id?: string; status?: string }).id === taskId
          && (event.payload as { id?: string; status?: string }).status === "refinement",
      );
      assert.ok(refinementUpdate, "should broadcast a refinement task_update when assigned agent is busy");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("sets refinement_revision_requested_at and clears completed_at on refinement feedback", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const beforeFeedback = Date.now();
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 }) as never,
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Update the plan scope." }),
      });
      assert.equal(response.status, 200);

      const row = db.prepare(
        "SELECT refinement_revision_requested_at, refinement_revision_completed_at FROM tasks WHERE id = ?",
      ).get(taskId) as { refinement_revision_requested_at: number | null; refinement_revision_completed_at: number | null };

      assert.ok(row.refinement_revision_requested_at, "refinement_revision_requested_at should be set");
      assert.ok(
        row.refinement_revision_requested_at >= beforeFeedback,
        "timestamp should be at or after the request",
      );
      assert.equal(
        row.refinement_revision_completed_at,
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

  it("resets in_progress task with auto_respawn_count = 0 on non-refinement feedback", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertInProgressTask(db, taskId, agentId);

    db.prepare("UPDATE tasks SET status = 'pr_review', completed_at = ?, auto_respawn_count = 3, updated_at = ? WHERE id = ?")
      .run(Date.now(), Date.now(), taskId);

    let spawnedPreviousStatus: string | undefined;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, _task, options) => {
        spawnedPreviousStatus = options?.previousStatus;
        return { pid: 1234 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rework the implementation." }),
      });
      assert.equal(response.status, 200);

      const row = db.prepare(
        "SELECT status, auto_respawn_count, completed_at FROM tasks WHERE id = ?",
      ).get(taskId) as { status: string; auto_respawn_count: number; completed_at: number | null };

      assert.equal(row.status, "in_progress", "status should be reset to in_progress");
      assert.equal(row.auto_respawn_count, 0, "auto_respawn_count should be reset to 0");
      assert.equal(row.completed_at, null, "completed_at should be cleared");
      assert.equal(spawnedPreviousStatus, "pr_review", "previousStatus should be the status before feedback");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("completed refinement with a busy assigned agent does not synthesize transitions and does not respawn", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertCompletedRefinementTask(db, taskId, agentId);

    let spawnCalls = 0;
    const beforeFeedback = Date.now();
    const { server, baseUrl, events } = await startServer(db, {
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
        body: JSON.stringify({ content: "Revise the completed plan once the busy agent frees up." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { sent: boolean; restarted: boolean };
      assert.equal(body.sent, true);
      assert.equal(body.restarted, false);
      assert.equal(spawnCalls, 0, "spawnAgent should not run while the assigned agent is busy");
      assert.deepEqual(getTransitions(db, taskId), [], "completed refinement should not record a synthetic round-trip");

      const row = db.prepare(
        "SELECT status, refinement_revision_requested_at, refinement_revision_completed_at FROM tasks WHERE id = ?",
      ).get(taskId) as {
        status: string;
        refinement_revision_requested_at: number | null;
        refinement_revision_completed_at: number | null;
      };
      assert.equal(row.status, "refinement");
      assert.ok(
        row.refinement_revision_requested_at && row.refinement_revision_requested_at >= beforeFeedback,
        "refinement_revision_requested_at should still be stamped",
      );
      assert.equal(row.refinement_revision_completed_at, null);

      const refinementUpdate = events.find(
        (event) => event.type === "task_update"
          && (event.payload as { id?: string; status?: string }).id === taskId
          && (event.payload as { id?: string; status?: string }).status === "refinement",
      );
      assert.ok(refinementUpdate, "should broadcast the refinement task state even when no respawn happens");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback additional coverage", () => {
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

  it("in_progress task with running process: restarts via queueFeedbackAndRestart, no stage transitions", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertInProgressTask(db, taskId, agentId);

    let queueCalls = 0;
    let queuedMessage = "";
    let queuedPreviousStatus = "";
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: (_id, msg, prev) => {
        queueCalls += 1;
        queuedMessage = msg;
        queuedPreviousStatus = prev;
        return true;
      },
      spawnAgent: async () => {
        throw new Error("spawnAgent should not run for in_progress running task");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Fix the edge case." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { sent: boolean; restarted: boolean };
      assert.equal(body.sent, true);
      assert.equal(body.restarted, true);
      assert.equal(queueCalls, 1);
      assert.equal(queuedMessage, "Fix the edge case.");
      assert.equal(queuedPreviousStatus, "in_progress");
      assert.deepEqual(getTransitions(db, taskId), [], "in_progress feedback should not produce refinement transitions");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("deleted agent (agent row missing): returns restarted=false, no spawn", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);

    let spawnCalls = 0;
    const { server, baseUrl, events } = await startServer(db, {
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
        body: JSON.stringify({ content: "Agent was deleted." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { sent: boolean; restarted: boolean };
      assert.equal(body.sent, true);
      assert.equal(body.restarted, false, "should not restart when agent row is missing");
      assert.equal(spawnCalls, 0);
      assert.deepEqual(getTransitions(db, taskId), [
        "__STAGE_TRANSITION__:refinement→inbox",
        "__STAGE_TRANSITION__:inbox→refinement",
      ]);
      const refinementUpdate = events.find(
        (event) => event.type === "task_update"
          && (event.payload as { id?: string; status?: string }).id === taskId
          && (event.payload as { id?: string; status?: string }).status === "refinement",
      );
      assert.ok(refinementUpdate, "should broadcast a refinement task_update when the assigned agent row is missing");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("persists feedback to file system and stores message in database", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 }) as never,
    });

    const feedbackContent = "Add retry logic for transient failures.";
    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: feedbackContent }),
      });
      assert.equal(response.status, 200);

      const feedbackPath = join("data", "feedback", `${taskId}.md`);
      assert.ok(existsSync(feedbackPath), "feedback file should exist");
      const fileContent = readFileSync(feedbackPath, "utf-8");
      assert.ok(fileContent.includes(feedbackContent), "feedback file should contain the content");
      assert.ok(fileContent.includes("CEO Feedback"), "feedback file should contain header");

      const msg = db.prepare(
        "SELECT content, message_type, sender_type FROM messages WHERE task_id = ? AND message_type = 'directive'",
      ).get(taskId) as { content: string; message_type: string; sender_type: string } | undefined;
      assert.ok(msg, "directive message should be stored");
      assert.equal(msg.content, feedbackContent);
      assert.equal(msg.sender_type, "user");

      const log = db.prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '[CEO Feedback]%'",
      ).get(taskId) as { message: string } | undefined;
      assert.ok(log, "CEO Feedback log should be stored");
      assert.ok(log.message.includes(feedbackContent));
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects whitespace-only content with 400", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 }) as never,
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "   " }),
      });
      assert.equal(response.status, 400);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("trims surrounding whitespace before storing feedback", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 }) as never,
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "  Tighten acceptance criteria.  " }),
      });
      assert.equal(response.status, 200);

      const msg = db.prepare(
        "SELECT content FROM messages WHERE task_id = ? AND message_type = 'directive'",
      ).get(taskId) as { content: string } | undefined;
      assert.ok(msg);
      assert.equal(msg.content, "Tighten acceptance criteria.");

      const log = db.prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '[CEO Feedback]%'",
      ).get(taskId) as { message: string } | undefined;
      assert.ok(log);
      assert.equal(log.message, "[CEO Feedback] Tighten acceptance criteria.");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("broadcasts task_update via websocket on non-refinement idle-agent path", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertInProgressTask(db, taskId, agentId);
    db.prepare("UPDATE tasks SET status = 'pr_review', updated_at = ? WHERE id = ?")
      .run(Date.now(), taskId);

    const { server, baseUrl, events } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 }) as never,
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Rework the PR." }),
      });
      assert.equal(response.status, 200);

      const taskUpdates = events.filter((e) => e.type === "task_update");
      assert.ok(taskUpdates.length >= 1, "should broadcast at least one task_update for status reset");

      const statusUpdate = taskUpdates.find(
        (e) => (e.payload as { status?: string }).status === "in_progress",
      );
      assert.ok(statusUpdate, "should broadcast task_update with in_progress status");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("spawnAgent failure does not crash the response (async fire-and-forget)", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => {
        throw new Error("simulated spawn failure");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "This should succeed despite spawn error." }),
      });
      // Response is sent before spawnAgent runs (fire-and-forget)
      assert.equal(response.status, 200);
      const body = await response.json() as { sent: boolean; restarted: boolean };
      assert.equal(body.sent, true);
      assert.equal(body.restarted, true);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("sequential feedbacks on refinement task accumulate correct number of transitions", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertRefinementTask(db, taskId, agentId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 1234 }) as never,
    });

    try {
      for (const msg of ["First feedback.", "Second feedback.", "Third feedback."]) {
        // Re-read agent status (spawnAgent mock sets it to working in real scenario)
        // Reset agent to idle for each iteration to simulate agent finishing
        db.prepare("UPDATE agents SET status = 'idle', updated_at = ? WHERE id = ?")
          .run(Date.now(), agentId);
        db.prepare("UPDATE tasks SET status = 'refinement', updated_at = ? WHERE id = ?")
          .run(Date.now(), taskId);

        const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: msg }),
        });
        assert.equal(response.status, 200);
      }

      const transitions = getTransitions(db, taskId);
      assert.equal(transitions.length, 6, "3 feedbacks × 2 transitions each = 6 total");
      for (let i = 0; i < transitions.length; i += 2) {
        assert.equal(transitions[i], "__STAGE_TRANSITION__:refinement→inbox");
        assert.equal(transitions[i + 1], "__STAGE_TRANSITION__:inbox→refinement");
      }

      const feedbackLogs = (
        db.prepare(
          "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '[CEO Feedback]%' ORDER BY id ASC",
        ).all(taskId) as Array<{ message: string }>
      );
      assert.equal(feedbackLogs.length, 3, "should have 3 CEO Feedback log entries");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("missing content field returns 400", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertUnassignedRefinementTask(db, taskId);

    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async () => ({ pid: 0 }) as never,
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 400, "missing content field should return 400");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
