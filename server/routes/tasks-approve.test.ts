import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { initializeDb } from "../db/runtime.js";
import { createTasksRouter } from "./tasks.js";

function createWsRecorder() {
  const events: Array<{ type: string; payload: unknown }> = [];
  return {
    ws: {
      broadcast(type: string, payload: unknown) {
        events.push({ type, payload });
      },
    },
    events,
  };
}

async function startServer(
  db: DatabaseSync,
  deps: Parameters<typeof createTasksRouter>[1],
): Promise<{ server: Server; baseUrl: string; events: Array<{ type: string; payload: unknown }> }> {
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function insertSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function insertAgent(
  db: DatabaseSync,
  overrides: {
    id: string;
    role?: string | null;
    status?: "idle" | "working" | "offline";
    current_task_id?: string | null;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (
      id, name, cli_provider, role, agent_type, status, current_task_id, created_at, updated_at
    ) VALUES (?, ?, 'codex', ?, 'worker', ?, ?, ?, ?)`,
  ).run(
    overrides.id,
    `Agent ${overrides.id}`,
    overrides.role ?? "lead_engineer",
    overrides.status ?? "idle",
    overrides.current_task_id ?? null,
    now,
    now,
  );
}

function insertRefinementTask(db: DatabaseSync, taskId: string, assignedAgentId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number,
      refinement_plan, refinement_completed_at, created_at, updated_at
    ) VALUES (?, 'Approve refinement', 'Approve refinement test', ?, 'refinement', 'medium', '#700',
      '---REFINEMENT PLAN---\nPlan\n---END REFINEMENT---', ?, ?, ?)`,
  ).run(taskId, assignedAgentId, now - 1_000, now, now);
}

describe("POST /tasks/:id/approve refinement implementer assignment", () => {
  it("splits an approved plan into parallel controller implement children when controller mode is enabled", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "enable_controller_mode", "true");
    insertSetting(db, "implementation_agent_role", "lead_engineer");
    insertAgent(db, { id: "planner", role: "planner" });
    const now = Date.now();
    const plan = [
      "---REFINEMENT PLAN---",
      "## Implementation Plan",
      "1. Update `server/routes/tasks.ts` for controller split approval",
      "2. Update `src/components/tasks/TaskDetailModal.tsx` copy",
      "---END REFINEMENT---",
    ].join("\n");
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        refinement_plan, refinement_completed_at, created_at, updated_at
      ) VALUES (?, 'Controller split parent', 'Controller split parent', ?, 'refinement', 'medium', '#710', ?, ?, ?, ?)`,
    ).run("task-controller-split", "planner", plan, now - 1_000, now, now);

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => {
        throw new Error("parent task should not spawn directly");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-controller-split/approve`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        approved: boolean;
        next_status: string;
        controller_mode: boolean;
        directive_id: string;
        children_count: number;
      };
      assert.equal(body.approved, true);
      assert.equal(body.next_status, "done");
      assert.equal(body.controller_mode, true);
      assert.equal(body.children_count, 2);

      const directive = db.prepare("SELECT status, controller_mode, controller_stage FROM directives WHERE id = ?")
        .get(body.directive_id) as { status: string; controller_mode: number; controller_stage: string };
      assert.equal(directive.status, "active");
      assert.equal(directive.controller_mode, 1);
      assert.equal(directive.controller_stage, "implement");

      const parent = db.prepare("SELECT status, result FROM tasks WHERE id = ?").get("task-controller-split") as {
        status: string;
        result: string | null;
      };
      assert.equal(parent.status, "done");
      assert.match(parent.result ?? "", /#\d+/);

      const children = db.prepare(
        "SELECT status, depends_on, controller_stage, refinement_completed_at, planned_files FROM tasks WHERE directive_id = ? ORDER BY created_at ASC",
      ).all(body.directive_id) as Array<{
        status: string;
        depends_on: string | null;
        controller_stage: string | null;
        refinement_completed_at: number | null;
        planned_files: string | null;
      }>;
      assert.equal(children.length, 2);
      assert.deepEqual(children.map((child) => child.status), ["inbox", "inbox"]);
      assert.deepEqual(children.map((child) => child.depends_on), [null, null]);
      assert.deepEqual(children.map((child) => child.controller_stage), ["implement", "implement"]);
      assert.ok(children.every((child) => child.refinement_completed_at !== null));
      assert.deepEqual(children.map((child) => JSON.parse(child.planned_files ?? "[]")), [
        ["server/routes/tasks.ts"],
        ["src/components/tasks/TaskDetailModal.tsx"],
      ]);

      const planner = db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'planner'")
        .get() as { status: string; current_task_id: string | null };
      assert.equal(planner.status, "idle");
      assert.equal(planner.current_task_id, null);

      await new Promise((resolve) => setTimeout(resolve, 600));
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("assigns and auto-runs the implementation role/model pool agent after refinement approval", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "implementation_agent_role", "architect");
    insertAgent(db, { id: "refinement-runner", role: "planner" });
    insertAgent(db, { id: "configured-impl", role: "architect" });
    insertAgent(db, { id: "fallback-impl", role: "lead_engineer" });
    insertRefinementTask(db, "task-approve-configured", "refinement-runner");

    const spawned: Array<{ agentId: string; taskId: string }> = [];
    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async (_db, _ws, agent, task) => {
        spawned.push({ agentId: agent.id, taskId: task.id });
        return { pid: 123 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-approve-configured/approve`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { approved: boolean; next_status: string };
      assert.deepEqual(body, { approved: true, next_status: "in_progress" });

      const row = db.prepare("SELECT status, assigned_agent_id FROM tasks WHERE id = ?").get("task-approve-configured") as {
        status: string;
        assigned_agent_id: string | null;
      };
      assert.equal(row.status, "in_progress");
      assert.equal(row.assigned_agent_id, "configured-impl");

      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.deepEqual(spawned, [{ agentId: "configured-impl", taskId: "task-approve-configured" }]);
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("excludes the refinement runner and falls back to another implementer when configured agent is unavailable", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "in_progress_agent_id", "deprecated-busy");
    insertAgent(db, { id: "refinement-runner", role: "planner" });
    insertAgent(db, {
      id: "deprecated-busy",
      role: "lead_engineer",
      status: "working",
      current_task_id: "other-task",
    });
    insertAgent(db, { id: "fallback-impl", role: "architect" });
    insertRefinementTask(db, "task-approve-1", "refinement-runner");

    const spawned: Array<{ agentId: string; taskId: string }> = [];
    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async (_db, _ws, agent, task) => {
        spawned.push({ agentId: agent.id, taskId: task.id });
        return { pid: 123 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-approve-1/approve`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { approved: boolean; next_status: string };
      assert.deepEqual(body, { approved: true, next_status: "in_progress" });

      const row = db.prepare("SELECT status, assigned_agent_id FROM tasks WHERE id = ?").get("task-approve-1") as {
        status: string;
        assigned_agent_id: string | null;
      };
      assert.equal(row.status, "in_progress");
      assert.equal(row.assigned_agent_id, "fallback-impl");
      assert.equal(spawned.length, 0, "auto-run may be delayed, but the task assignment must be committed first");
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("returns a retryable deferred response when only the refinement runner is available", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertAgent(db, { id: "refinement-runner", role: "planner" });
    insertRefinementTask(db, "task-approve-2", "refinement-runner");

    let spawnCalls = 0;
    const { server, baseUrl, events } = await startServer(db, {
      spawnAgent: async () => {
        spawnCalls += 1;
        return { pid: 123 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-approve-2/approve`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        approved: boolean;
        deferred: boolean;
        reason: string;
        next_status: string;
        returned_to: string;
      };
      assert.deepEqual(body, {
        approved: true,
        deferred: true,
        reason: "no_implementer_available",
        next_status: "inbox",
        returned_to: "inbox",
      });

      const row = db.prepare("SELECT status, assigned_agent_id, started_at FROM tasks WHERE id = ?").get("task-approve-2") as {
        status: string;
        assigned_agent_id: string | null;
        started_at: number | null;
      };
      assert.equal(row.status, "inbox");
      assert.equal(row.assigned_agent_id, null);
      assert.equal(row.started_at, null);
      assert.equal(spawnCalls, 0);
      assert.ok(
        events.some((event) => event.type === "task_update"),
        "expected retryable inbox transition to be broadcast",
      );
    } finally {
      await closeServer(server);
      db.close();
    }
  });
});
