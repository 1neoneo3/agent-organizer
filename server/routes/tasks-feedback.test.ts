import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTasksRouter } from "./tasks.js";
import { initializeDb } from "../db/runtime.js";
import {
  clearPendingInteractivePrompt,
  getAllPendingInteractivePrompts,
} from "../spawner/process-manager.js";

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

function createDb(): DatabaseSync {
  return initializeDb(":memory:");
}

async function startServer(
  db: DatabaseSync,
  deps: Parameters<typeof createTasksRouter>[1],
): Promise<{ server: Server; baseUrl: string; events: Array<{ type: string; payload: unknown; options?: unknown }> }> {
  const { ws, events } = createWsRecorder();
  const app = express();
  app.use(express.json());
  app.use(createTasksRouter({ db, ws: ws as never }, deps));

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

function insertAgent(
  db: DatabaseSync,
  agentId: string,
  status: "idle" | "working" | "offline",
  role: string | null = null,
  agentType: "worker" | "ceo" = "worker",
  currentTaskId: string | null = null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (id, name, cli_provider, status, role, agent_type, current_task_id, created_at, updated_at)
     VALUES (?, ?, 'claude', ?, ?, ?, ?, ?, ?)`,
  ).run(agentId, `Agent ${agentId}`, status, role, agentType, currentTaskId, now, now);
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

function insertAutoStageTask(
  db: DatabaseSync,
  taskId: string,
  agentId: string,
  status: "test_generation" | "qa_testing" | "pr_review" | "human_review",
): void {
  const now = Date.now();
  const taskNumber = `#${++testTaskSeq}`;
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, ?)`,
  ).run(taskId, "Auto-stage feedback test task", "Auto-stage resume regression", agentId, status, taskNumber, now, now);
}

function getTransitions(db: DatabaseSync, taskId: string): string[] {
  return (
    db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '__STAGE_TRANSITION__:%' ORDER BY id ASC",
    ).all(taskId) as Array<{ message: string }>
  ).map((row) => row.message);
}

function getSystemLogs(db: DatabaseSync, taskId: string): string[] {
  return (
    db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY id ASC",
    ).all(taskId) as Array<{ message: string }>
  ).map((row) => row.message);
}

function getTaskField(db: DatabaseSync, taskId: string, field: string): unknown {
  const row = db.prepare(`SELECT ${field} FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown> | undefined;
  return row?.[field];
}

function insertCompletedRefinementTask(db: DatabaseSync, taskId: string, agentId: string): void {
  insertRefinementTask(db, taskId, agentId);
  const completedAt = Date.now() - 5_000;
  db.prepare(
    `UPDATE tasks
     SET completed_at = ?,
         refinement_completed_at = ?,
         refinement_plan = ?
     WHERE id = ?`,
  ).run(
    completedAt,
    completedAt,
    "---REFINEMENT PLAN---\nOriginal plan\n---END REFINEMENT---",
    taskId,
  );
}

describe("POST /tasks/:id/feedback refinement regressions", () => {
  let tmpFeedbackDir: string;

  beforeEach(() => {
    tmpFeedbackDir = mkdtempSync(join(tmpdir(), "ao-feedback-test-"));
    process.env.AO_FEEDBACK_DIR = tmpFeedbackDir;
  });

  afterEach(() => {
    delete process.env.AO_FEEDBACK_DIR;
    rmSync(tmpFeedbackDir, { recursive: true, force: true });
  });

  it("records one refinement round-trip when an active child process is restarted", async () => {
    const db = createDb();
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
      assert.deepEqual(getSystemLogs(db, taskId), [
        "[CEO Feedback] Revise the plan.",
        "__STAGE_TRANSITION__:refinement→inbox",
        "[Revise] Refinement plan revision requested. Returning to inbox before re-entering refinement.",
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
    const db = createDb();
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
      assert.deepEqual(getSystemLogs(db, taskId), [
        "[CEO Feedback] Tighten the acceptance criteria.",
        "__STAGE_TRANSITION__:refinement→inbox",
        "[Revise] Refinement plan revision requested. Returning to inbox before re-entering refinement.",
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

  it("clears completed_at and restarts when revising a completed refinement with an active agent", async () => {
    const db = createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertCompletedRefinementTask(db, taskId, agentId);

    let queueCalls = 0;
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => {
        queueCalls += 1;
        return true;
      },
      spawnAgent: async () => {
        throw new Error("spawnAgent should not run when revision restart stays in-process");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Re-open the plan and add test coverage." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(queueCalls, 1);
      assert.equal(getTaskField(db, taskId, "status"), "refinement");
      assert.equal(getTaskField(db, taskId, "completed_at"), null);
      assert.equal(getTaskField(db, taskId, "refinement_revision_completed_at"), null);
      assert.ok(
        typeof getTaskField(db, taskId, "refinement_revision_requested_at") === "number",
        "refinement_revision_requested_at should be stamped",
      );
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

  it("clears completed_at on idle-agent respawn for a completed refinement revision", async () => {
    const db = createDb();
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
        body: JSON.stringify({ content: "Revise the acceptance criteria ordering." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls, 1);
      assert.equal(getTaskField(db, taskId, "status"), "refinement");
      assert.equal(getTaskField(db, taskId, "completed_at"), null);
      assert.deepEqual(getSystemLogs(db, taskId), [
        "[CEO Feedback] Revise the acceptance criteria ordering.",
        "__STAGE_TRANSITION__:refinement→inbox",
        "[Revise] Refinement plan revision requested. Returning to inbox before re-entering refinement.",
        "__STAGE_TRANSITION__:inbox→refinement",
      ]);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/interactive-response auto-stage resume", () => {
  let tmpFeedbackDir: string;

  beforeEach(() => {
    tmpFeedbackDir = mkdtempSync(join(tmpdir(), "ao-interactive-test-"));
    process.env.AO_FEEDBACK_DIR = tmpFeedbackDir;
  });

  afterEach(() => {
    delete process.env.AO_FEEDBACK_DIR;
    rmSync(tmpFeedbackDir, { recursive: true, force: true });
  });

  it("resumes an auto-stage prompt with the saved runner and stage without implementer fallback", async () => {
    const db = createDb();
    const implementerId = randomUUID();
    const qaRunnerId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, implementerId, "idle", "lead_engineer");
    insertAgent(db, qaRunnerId, "idle", "tester");
    insertAutoStageTask(db, taskId, implementerId, "qa_testing");

    getAllPendingInteractivePrompts().set(taskId, {
      data: {
        promptType: "ask_user_question",
        toolUseId: "tool-1",
        questions: [{ question: "Scope?", options: [{ label: "Full" }] }],
      },
      createdAt: Date.now(),
      spawnStage: "qa_testing",
      runnerAgentId: qaRunnerId,
    } as never);

    const spawnCalls: Array<{
      agentId: string;
      taskStatus: string;
      assignedAgentId: string | null;
      previousStatus: string | undefined;
    }> = [];
    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async (_db, _ws, agent, task, options) => {
        spawnCalls.push({
          agentId: agent.id,
          taskStatus: task.status,
          assignedAgentId: task.assigned_agent_id,
          previousStatus: options?.previousStatus,
        });
        return { pid: 1234 };
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/interactive-response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          promptType: "ask_user_question",
          selectedOptions: { "Scope?": "Full" },
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].agentId, qaRunnerId);
      assert.equal(spawnCalls[0].taskStatus, "qa_testing");
      assert.equal(spawnCalls[0].assignedAgentId, implementerId);
      assert.equal(spawnCalls[0].previousStatus, "qa_testing");
      assert.equal(getTaskField(db, taskId, "status"), "qa_testing");
      assert.equal(getTaskField(db, taskId, "assigned_agent_id"), implementerId);
    } finally {
      clearPendingInteractivePrompt(taskId, db);
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("POST /tasks/:id/feedback auto-stage resume", () => {
  let tmpFeedbackDir: string;

  beforeEach(() => {
    tmpFeedbackDir = mkdtempSync(join(tmpdir(), "ao-feedback-autostage-test-"));
    process.env.AO_FEEDBACK_DIR = tmpFeedbackDir;
  });

  afterEach(() => {
    delete process.env.AO_FEEDBACK_DIR;
    rmSync(tmpFeedbackDir, { recursive: true, force: true });
  });

  it("keeps human_review as the resume stage instead of forcing in_progress", async () => {
    const db = createDb();
    const implementerId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, implementerId, "idle", "lead_engineer");
    insertAutoStageTask(db, taskId, implementerId, "human_review");

    const spawnCalls: Array<{
      taskStatus: string;
      assignedAgentId: string | null;
      previousStatus: string | undefined;
    }> = [];
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, _agent, task, options) => {
        spawnCalls.push({
          taskStatus: task.status,
          assignedAgentId: task.assigned_agent_id,
          previousStatus: options?.previousStatus,
        });
        return { pid: 1234 };
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Re-check the final review criteria." }),
      });
      assert.equal(response.status, 200);

      const body = await response.json() as { restarted: boolean };
      assert.equal(body.restarted, true);
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].taskStatus, "human_review");
      assert.equal(spawnCalls[0].assignedAgentId, implementerId);
      assert.equal(spawnCalls[0].previousStatus, "human_review");
      assert.equal(getTaskField(db, taskId, "status"), "human_review");
      assert.equal(getTaskField(db, taskId, "assigned_agent_id"), implementerId);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not resume guarded stages with an offline assigned runner", async () => {
    const db = createDb();
    const implementerId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, implementerId, "offline", "lead_engineer");
    insertAutoStageTask(db, taskId, implementerId, "human_review");

    const spawnCalls: string[] = [];
    const { server, baseUrl } = await startServer(db, {
      queueFeedbackAndRestart: () => false,
      spawnAgent: async (_db, _ws, agent) => {
        spawnCalls.push(agent.id);
        return { pid: 1234 };
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/${taskId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Re-check the final review criteria." }),
      });

      assert.equal(response.status, 200);
      const body = await response.json() as { restarted: boolean; resolution?: string };
      assert.equal(body.restarted, false);
      assert.equal(body.resolution, "no_runner_available");
      assert.deepEqual(spawnCalls, []);
      assert.equal(getTaskField(db, taskId, "status"), "human_review");
      assert.equal(getTaskField(db, taskId, "assigned_agent_id"), implementerId);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
