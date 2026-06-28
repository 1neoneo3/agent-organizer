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
      "1. Update controller split approval",
      "   Write scope: `server/routes/tasks.ts`",
      "2. Update task detail copy",
      "   Write scope: `src/components/tasks/TaskDetailModal.tsx`",
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
        "SELECT status, depends_on, controller_stage, refinement_completed_at, planned_files, parent_task_id, parent_task_number, split_index, split_total FROM tasks WHERE directive_id = ? ORDER BY created_at ASC",
      ).all(body.directive_id) as Array<{
        status: string;
        depends_on: string | null;
        controller_stage: string | null;
        refinement_completed_at: number | null;
        planned_files: string | null;
        parent_task_id: string | null;
        parent_task_number: string | null;
        split_index: number | null;
        split_total: number | null;
      }>;
      assert.equal(children.length, 2);
      assert.deepEqual(children.map((child) => child.status), ["inbox", "inbox"]);
      assert.deepEqual(children.map((child) => child.depends_on), [null, null]);
      assert.deepEqual(children.map((child) => child.controller_stage), ["implement", "implement"]);
      assert.deepEqual(children.map((child) => child.parent_task_id), ["task-controller-split", "task-controller-split"]);
      assert.deepEqual(children.map((child) => child.parent_task_number), ["#710", "#710"]);
      assert.deepEqual(children.map((child) => child.split_index), [1, 2]);
      assert.deepEqual(children.map((child) => child.split_total), [2, 2]);
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

  it("uses task-level controller mode overrides when approving refinement", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "false");
    insertSetting(db, "enable_controller_mode", "false");
    insertSetting(db, "implementation_agent_role", "lead_engineer");
    insertAgent(db, { id: "planner", role: "planner" });
    const now = Date.now();
    const plan = [
      "---REFINEMENT PLAN---",
      "## Implementation Plan",
      "1. Task override controller split",
      "   Write scope: `server/routes/tasks.ts`",
      "---END REFINEMENT---",
    ].join("\n");
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        refinement_plan, refinement_completed_at, settings_overrides, created_at, updated_at
      ) VALUES (?, 'Controller override parent', 'Controller override parent', ?, 'refinement', 'medium', '#713', ?, ?, ?, ?, ?)`,
    ).run(
      "task-controller-override-enabled",
      "planner",
      plan,
      now - 1_000,
      JSON.stringify({ enable_controller_mode: "true", default_enable_refinement: "true" }),
      now,
      now,
    );

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => {
        throw new Error("task-level controller approval should split instead of spawning the parent");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-controller-override-enabled/approve`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        controller_mode: boolean;
        children_count: number;
      };
      assert.equal(body.controller_mode, true);
      assert.equal(body.children_count, 1);

      await new Promise((resolve) => setTimeout(resolve, 600));
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("uses task-level controller mode overrides when manually splitting refinement", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "enable_controller_mode", "false");
    insertSetting(db, "implementation_agent_role", "lead_engineer");
    insertAgent(db, { id: "planner", role: "planner" });
    const now = Date.now();
    const plan = [
      "---REFINEMENT PLAN---",
      "## Implementation Plan",
      "1. Manual split with task override",
      "   Write scope: `server/routes/tasks.ts`",
      "---END REFINEMENT---",
    ].join("\n");
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        refinement_plan, refinement_completed_at, settings_overrides, created_at, updated_at
      ) VALUES (?, 'Controller manual split parent', 'Controller manual split parent', ?, 'refinement', 'medium', '#716', ?, ?, ?, ?, ?)`,
    ).run(
      "task-controller-manual-split-override",
      "planner",
      plan,
      now - 1_000,
      JSON.stringify({ enable_controller_mode: "true" }),
      now,
      now,
    );

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => {
        throw new Error("manual controller split assertion should not need real spawning");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-controller-manual-split-override/split`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        controller_mode: boolean;
        directive_id: string | null;
        children: Array<{ controller_stage: string | null; write_scope: string | null }>;
      };
      assert.equal(body.controller_mode, true);
      assert.ok(body.directive_id);
      assert.deepEqual(body.children.map((child) => child.controller_stage), ["implement"]);
      assert.deepEqual(body.children.map((child) => JSON.parse(child.write_scope ?? "[]")), [
        ["server/routes/tasks.ts"],
      ]);

      await new Promise((resolve) => setTimeout(resolve, 600));
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("does not use global controller mode when a task override disables it", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "enable_controller_mode", "true");
    insertSetting(db, "implementation_agent_role", "lead_engineer");
    insertAgent(db, { id: "planner", role: "planner" });
    insertAgent(db, { id: "implementer", role: "lead_engineer" });
    const now = Date.now();
    const plan = [
      "---REFINEMENT PLAN---",
      "## Implementation Plan",
      "1. Normal implementation without controller write scope",
      "---END REFINEMENT---",
    ].join("\n");
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        refinement_plan, refinement_completed_at, settings_overrides, created_at, updated_at
      ) VALUES (?, 'Controller override disabled parent', 'Controller override disabled parent', ?, 'refinement', 'medium', '#714', ?, ?, ?, ?, ?)`,
    ).run(
      "task-controller-override-disabled",
      "planner",
      plan,
      now - 1_000,
      JSON.stringify({ enable_controller_mode: "false" }),
      now,
      now,
    );

    const spawned: Array<{ agentId: string; taskId: string }> = [];
    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async (_db, _ws, agent, task) => {
        spawned.push({ agentId: agent.id, taskId: task.id });
        return { pid: 321 } as never;
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-controller-override-disabled/approve`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { approved: boolean; next_status: string };
      assert.deepEqual(body, { approved: true, next_status: "in_progress" });

      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.deepEqual(spawned, [{ agentId: "implementer", taskId: "task-controller-override-disabled" }]);
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("splits multiline implementation steps and extracts write scopes from continuation lines", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "enable_controller_mode", "true");
    insertSetting(db, "implementation_agent_role", "lead_engineer");
    insertAgent(db, { id: "planner", role: "planner" });
    const now = Date.now();
    const plan = [
      "---REFINEMENT PLAN---",
      "## 実装計画",
      "1. Algorithm/core lib",
      "   Write scope: `src/lib/catFeatures.ts`, `src/lib/catFeatures.test.ts`, `src/lib/algorithms/sortCats.ts`",
      "   Implement deterministic feature and sort helpers with focused tests.",
      "",
      "2. API/fallback",
      "   Write scope: `src/lib/catApi.ts`, `src/lib/fallbackCats.ts`, `src/lib/catApi.test.ts`",
      "   Preserve fetchRandomCat and add fallback dataset loading.",
      "",
      "## 統合方針",
      "- Integrate later in `src/App.tsx` after child tasks finish.",
      "---END REFINEMENT---",
    ].join("\n");
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        refinement_plan, refinement_completed_at, created_at, updated_at
      ) VALUES (?, 'Controller multiline split parent', 'Controller multiline split parent', ?, 'refinement', 'medium', '#711', ?, ?, ?, ?)`,
    ).run("task-controller-multiline-split", "planner", plan, now - 1_000, now, now);

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => {
        throw new Error("child auto-dispatch is not part of this assertion");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-controller-multiline-split/approve`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        controller_mode: boolean;
        directive_id: string;
        children_count: number;
      };
      assert.equal(body.controller_mode, true);
      assert.equal(body.children_count, 2);

      const children = db.prepare(
        "SELECT title, planned_files, write_scope FROM tasks WHERE directive_id = ? ORDER BY created_at ASC",
      ).all(body.directive_id) as Array<{
        title: string;
        planned_files: string | null;
        write_scope: string | null;
      }>;
      assert.deepEqual(children.map((child) => child.title), ["Algorithm/core lib", "API/fallback"]);
      assert.deepEqual(children.map((child) => JSON.parse(child.planned_files ?? "[]")), [
        ["src/lib/catFeatures.ts", "src/lib/catFeatures.test.ts", "src/lib/algorithms/sortCats.ts"],
        ["src/lib/catApi.ts", "src/lib/fallbackCats.ts", "src/lib/catApi.test.ts"],
      ]);
      assert.deepEqual(children.map((child) => JSON.parse(child.write_scope ?? "[]")), [
        ["src/lib/catFeatures.ts", "src/lib/catFeatures.test.ts", "src/lib/algorithms/sortCats.ts"],
        ["src/lib/catApi.ts", "src/lib/fallbackCats.ts", "src/lib/catApi.test.ts"],
      ]);

      await new Promise((resolve) => setTimeout(resolve, 600));
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("splits Step-labeled plans and extracts Japanese write scope lines", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "enable_controller_mode", "true");
    insertSetting(db, "implementation_agent_role", "lead_engineer");
    insertAgent(db, { id: "planner", role: "planner" });
    const now = Date.now();
    const plan = [
      "---REFINEMENT PLAN---",
      "目的:",
      "Approve Plan が controller split で扱える形式を広めに受け付ける。",
      "",
      "Step 1: fallback metadata をデータ層に固定する",
      "- 書き込み対象は `src/lib/catApi.ts`, `src/lib/fallbackCats.ts`, `src/lib/catApi.test.ts` に限定する。",
      "- fallback metadata を維持する。",
      "",
      "Step 2: dataset hook を専用ファイルに実装する",
      "- 書き込み対象は `src/hooks/useCatDataset.ts`, `src/hooks/useCatDataset.test.ts` に限定する。",
      "- App から hook を利用できるようにする。",
      "",
      "受け入れ条件:",
      "- Approve Plan が no_implementation_steps で失敗しない。",
      "---END REFINEMENT---",
    ].join("\n");
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        refinement_plan, refinement_completed_at, created_at, updated_at
      ) VALUES (?, 'Controller step-label split parent', 'Controller step-label split parent', ?, 'refinement', 'medium', '#717', ?, ?, ?, ?)`,
    ).run("task-controller-step-label-split", "planner", plan, now - 1_000, now, now);

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => {
        throw new Error("child auto-dispatch is not part of this assertion");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-controller-step-label-split/approve`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        controller_mode: boolean;
        directive_id: string;
        children_count: number;
      };
      assert.equal(body.controller_mode, true);
      assert.equal(body.children_count, 2);

      const children = db.prepare(
        "SELECT title, planned_files, write_scope FROM tasks WHERE directive_id = ? ORDER BY created_at ASC",
      ).all(body.directive_id) as Array<{
        title: string;
        planned_files: string | null;
        write_scope: string | null;
      }>;
      assert.deepEqual(children.map((child) => child.title), [
        "fallback metadata をデータ層に固定する",
        "dataset hook を専用ファイルに実装する",
      ]);
      assert.deepEqual(children.map((child) => JSON.parse(child.planned_files ?? "[]")), [
        ["src/lib/catApi.ts", "src/lib/fallbackCats.ts", "src/lib/catApi.test.ts"],
        ["src/hooks/useCatDataset.ts", "src/hooks/useCatDataset.test.ts"],
      ]);
      assert.deepEqual(children.map((child) => JSON.parse(child.write_scope ?? "[]")), [
        ["src/lib/catApi.ts", "src/lib/fallbackCats.ts", "src/lib/catApi.test.ts"],
        ["src/hooks/useCatDataset.ts", "src/hooks/useCatDataset.test.ts"],
      ]);

      await new Promise((resolve) => setTimeout(resolve, 600));
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("rejects controller approval when an implementation step has no write scope", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "enable_controller_mode", "true");
    insertAgent(db, { id: "planner", role: "planner" });
    const now = Date.now();
    const plan = [
      "---REFINEMENT PLAN---",
      "## Implementation Plan",
      "1. Implement the feature without naming files",
      "---END REFINEMENT---",
    ].join("\n");
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        refinement_plan, refinement_completed_at, created_at, updated_at
      ) VALUES (?, 'Controller bad split parent', 'Controller bad split parent', ?, 'refinement', 'medium', '#712', ?, ?, ?, ?)`,
    ).run("task-controller-missing-scope", "planner", plan, now - 1_000, now, now);

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => {
        throw new Error("invalid controller split must not spawn");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-controller-missing-scope/approve`, { method: "POST" });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string; step: number; message: string };
      assert.equal(body.error, "missing_write_scope");
      assert.equal(body.step, 1);
      assert.match(body.message, /Write scope/);

      const parent = db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-controller-missing-scope") as {
        status: string;
      };
      assert.equal(parent.status, "refinement");
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("rejects controller approval when backtick paths are not on a Write scope line", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "enable_controller_mode", "true");
    insertAgent(db, { id: "planner", role: "planner" });
    const now = Date.now();
    const plan = [
      "---REFINEMENT PLAN---",
      "## Implementation Plan",
      "1. Mention files in prose",
      "   Update `src/lib/catApi.ts` and call `Promise.allSettled` in the helper.",
      "---END REFINEMENT---",
    ].join("\n");
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        refinement_plan, refinement_completed_at, created_at, updated_at
      ) VALUES (?, 'Controller prose path parent', 'Controller prose path parent', ?, 'refinement', 'medium', '#715', ?, ?, ?, ?)`,
    ).run("task-controller-prose-path", "planner", plan, now - 1_000, now, now);

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => {
        throw new Error("invalid controller split must not spawn");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-controller-prose-path/approve`, { method: "POST" });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string; step: number; message: string };
      assert.equal(body.error, "missing_write_scope");
      assert.equal(body.step, 1);
      assert.match(body.message, /Write scope/);
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("does not include code identifiers from Write scope lines in planned files", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "enable_controller_mode", "true");
    insertSetting(db, "implementation_agent_role", "lead_engineer");
    insertAgent(db, { id: "planner", role: "planner" });
    const now = Date.now();
    const plan = [
      "---REFINEMENT PLAN---",
      "## Implementation Plan",
      "1. Scope line with implementation note",
      "   Write scope: `src/lib/catApi.ts`, `package.json`; use `Promise.allSettled` while editing.",
      "---END REFINEMENT---",
    ].join("\n");
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        refinement_plan, refinement_completed_at, created_at, updated_at
      ) VALUES (?, 'Controller scoped code token parent', 'Controller scoped code token parent', ?, 'refinement', 'medium', '#717', ?, ?, ?, ?)`,
    ).run("task-controller-scoped-code-token", "planner", plan, now - 1_000, now, now);

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => {
        throw new Error("child auto-dispatch is not part of this assertion");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/tasks/task-controller-scoped-code-token/approve`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        directive_id: string;
        children_count: number;
      };
      assert.equal(body.children_count, 1);

      const child = db.prepare(
        "SELECT planned_files, write_scope FROM tasks WHERE directive_id = ?",
      ).get(body.directive_id) as { planned_files: string | null; write_scope: string | null };
      assert.deepEqual(JSON.parse(child.planned_files ?? "[]"), ["src/lib/catApi.ts", "package.json"]);
      assert.deepEqual(JSON.parse(child.write_scope ?? "[]"), ["src/lib/catApi.ts", "package.json"]);

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

describe("POST /tasks/:id/approve human review", () => {
  it("clears exhausted auto human review state after manual approval", async () => {
    const db = initializeDb(":memory:");
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, status, task_size, task_number,
        created_at, updated_at
      ) VALUES (?, 'Approve human review', 'Approve human review test', NULL, 'human_review', 'medium', '#720', ?, ?)`,
    ).run("task-human-review-approve", now, now);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'system', ?, 'human_review', ?)",
    ).run("task-human-review-approve", "[HUMAN_REVIEW_AUTO:EXHAUSTED] iterations reached max", now - 10_000);

    const { server, baseUrl, events } = await startServer(db, {});

    try {
      const response = await fetch(`${baseUrl}/tasks/task-human-review-approve/approve`, { method: "POST" });
      assert.equal(response.status, 200);

      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-human-review-approve") as { status: string };
      assert.equal(task.status, "done");

      const latestMarker = db.prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '[HUMAN_REVIEW_AUTO:%' ORDER BY created_at DESC, id DESC LIMIT 1",
      ).get("task-human-review-approve") as { message: string };
      assert.match(latestMarker.message, /^\[HUMAN_REVIEW_AUTO:CLEARED\]/);

      const taskUpdate = events.find((event) => event.type === "task_update");
      assert.ok(taskUpdate);
      assert.equal((taskUpdate.payload as { status?: string }).status, "done");
      assert.equal((taskUpdate.payload as { human_review_auto_status?: string }).human_review_auto_status, "cleared");
    } finally {
      await closeServer(server);
      db.close();
    }
  });
});
