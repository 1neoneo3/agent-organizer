import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { SCHEMA_SQL } from "../db/schema.js";
import { createTasksRouter } from "./tasks.js";
import { clearPendingInteractivePrompt } from "../spawner/process-manager.js";

const HEAVY_COLUMNS = [
  "description",
  "result",
  "refinement_plan",
  "interactive_prompt_data",
  "repository_urls",
  "pr_urls",
  "merged_pr_urls",
] as const;

const SUMMARY_COLUMNS = [
  "id", "title", "assigned_agent_id", "project_path", "status",
  "priority", "task_size", "task_number", "parent_task_id",
  "parent_task_number", "parent_task_title", "split_index", "split_total",
  "depends_on", "planned_files", "controller_stage",
  "refinement_completed_at", "refinement_revision_requested_at",
  "refinement_revision_completed_at", "review_count", "directive_id",
  "pr_url", "external_source", "external_id", "review_branch",
  "review_commit_sha", "review_sync_status", "review_sync_error",
  "repository_url", "settings_overrides", "started_at", "completed_at",
  "last_heartbeat_at", "auto_respawn_count", "created_at", "updated_at",
] as const;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function insertTaskWithHeavyData(
  db: DatabaseSync,
  id: string,
  status = "in_progress",
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, status, task_size, task_number,
      result, refinement_plan, planned_files,
      interactive_prompt_data, repository_urls, pr_urls, merged_pr_urls,
      repository_url, pr_url, settings_overrides,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'medium', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `Task ${id}`,
    "A long description with lots of detail ".repeat(100),
    status,
    `#${id}`,
    "Task result output ".repeat(200),
    "## Refinement Plan\n\n- Step 1\n- Step 2\n".repeat(50),
    JSON.stringify([{ path: "src/main.ts", action: "modify" }]),
    JSON.stringify({ promptType: "exit_plan_mode", message: "Need approval" }),
    JSON.stringify(["https://github.com/org/repo1", "https://github.com/org/repo2"]),
    JSON.stringify(["https://github.com/org/repo1/pull/1"]),
    JSON.stringify(["https://github.com/org/repo1/pull/2"]),
    "https://github.com/org/repo1",
    "https://github.com/org/repo1/pull/1",
    JSON.stringify({ review_mode: "pr_only" }),
    now,
    now,
  );
}

describe("GET /tasks summary", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl = "";
  const taskIds: string[] = [];

  beforeEach(async () => {
    db = createDb();
    const ids = ["task-a", "task-b", "task-c"];
    for (const id of ids) {
      insertTaskWithHeavyData(db, id, id === "task-c" ? "done" : "in_progress");
    }
    taskIds.length = 0;
    taskIds.push(...ids);

    const app = express();
    app.use(express.json());
    app.use(createTasksRouter({ db, ws: { broadcast() {} } as never }));

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const id of taskIds) clearPendingInteractivePrompt(id);
    db.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("excludes heavy columns from the list response", async () => {
    const res = await fetch(`${baseUrl}/tasks`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as Record<string, unknown>[];

    assert.ok(tasks.length >= 3);
    for (const task of tasks) {
      for (const col of HEAVY_COLUMNS) {
        assert.equal(
          col in task,
          false,
          `GET /tasks should not include '${col}', but it was present on task ${task.id}`,
        );
      }
    }
  });

  it("includes all summary columns in the list response", async () => {
    const res = await fetch(`${baseUrl}/tasks`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as Record<string, unknown>[];

    assert.ok(tasks.length >= 1);
    const task = tasks[0]!;
    for (const col of SUMMARY_COLUMNS) {
      assert.ok(
        col in task,
        `GET /tasks should include '${col}', but it was missing`,
      );
    }
  });

  it("returns explicit split parent metadata with the parent title", async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number, created_at, updated_at
      ) VALUES ('parent-task', '親の実装計画', 'parent', 'done', 'large', '#900', ?, ?)`,
    ).run(now + 1, now + 1);
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number,
        parent_task_id, parent_task_number, split_index, split_total,
        created_at, updated_at
      ) VALUES ('child-task', '子タスク', 'child', 'inbox', 'small', '#901',
        'parent-task', '#900', 2, 4, ?, ?)`,
    ).run(now + 2, now + 2);

    const res = await fetch(`${baseUrl}/tasks`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as Array<Record<string, unknown>>;
    const child = tasks.find((task) => task.id === "child-task");

    assert.ok(child);
    assert.equal(child.parent_task_id, "parent-task");
    assert.equal(child.parent_task_number, "#900");
    assert.equal(child.parent_task_title, "親の実装計画");
    assert.equal(child.split_index, 2);
    assert.equal(child.split_total, 4);
  });

  it("falls back to Japanese split descriptions for existing child tasks", async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number, created_at, updated_at
      ) VALUES ('legacy-parent', '既存の親タスク', 'parent', 'done', 'large', '#910', ?, ?)`,
    ).run(now + 1, now + 1);
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number, created_at, updated_at
      ) VALUES ('legacy-child', '既存の子タスク', '#910 のステップ 3: UI components/styles', 'in_progress', 'small', '#913', ?, ?)`,
    ).run(now + 2, now + 2);

    const res = await fetch(`${baseUrl}/tasks`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as Array<Record<string, unknown>>;
    const child = tasks.find((task) => task.id === "legacy-child");

    assert.ok(child);
    assert.equal(child.parent_task_id, "legacy-parent");
    assert.equal(child.parent_task_number, "#910");
    assert.equal(child.parent_task_title, "既存の親タスク");
    assert.equal(child.split_index, 3);
  });

  it("falls back to T-prefixed parent task numbers for controller children", async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number, created_at, updated_at
      ) VALUES ('t04-parent', 'Integrate controller results', 'parent', 'done', 'large', 'T04', ?, ?)`,
    ).run(now + 1, now + 1);
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number, created_at, updated_at
      ) VALUES ('t04-child', 'fallback metadata', 'T04 のステップ 1: fallback metadata', 'human_review', 'small', '#82168', ?, ?)`,
    ).run(now + 2, now + 2);

    const res = await fetch(`${baseUrl}/tasks`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as Array<Record<string, unknown>>;
    const child = tasks.find((task) => task.id === "t04-child");

    assert.ok(child);
    assert.equal(child.parent_task_id, "t04-parent");
    assert.equal(child.parent_task_number, "T04");
    assert.equal(child.parent_task_title, "Integrate controller results");
    assert.equal(child.split_index, 1);
  });

  it("prefers the latest non-cancelled parent when task numbers are duplicated", async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number, created_at, updated_at
      ) VALUES ('old-t04-parent', 'Old cancelled T04', 'old parent', 'cancelled', 'large', 'T04', ?, ?)`,
    ).run(now + 1, now + 1);
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number, created_at, updated_at
      ) VALUES ('new-t04-parent', 'Current T04', 'new parent', 'done', 'large', 'T04', ?, ?)`,
    ).run(now + 2, now + 2);
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number, created_at, updated_at
      ) VALUES ('duplicate-t04-child', 'child', 'T04 のステップ 2: child', 'human_review', 'small', '#82200', ?, ?)`,
    ).run(now + 3, now + 3);

    const res = await fetch(`${baseUrl}/tasks`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as Array<Record<string, unknown>>;
    const child = tasks.find((task) => task.id === "duplicate-t04-child");

    assert.ok(child);
    assert.equal(child.parent_task_id, "new-t04-parent");
    assert.equal(child.parent_task_title, "Current T04");
  });

  it("infers controller integrate parent metadata from sibling split tasks", async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO directives (
        id, title, content, status, project_path, controller_mode, controller_stage,
        created_at, updated_at
      ) VALUES ('directive-integrate', 'Controller: #920 親のController作業', 'content', 'active', '/tmp/project', 1, 'integrate', ?, ?)`,
    ).run(now + 1, now + 1);
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number, created_at, updated_at
      ) VALUES ('controller-parent', '親のController作業', 'parent', 'done', 'large', '#920', ?, ?)`,
    ).run(now + 2, now + 2);
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number,
        parent_task_id, parent_task_number, directive_id, controller_stage,
        created_at, updated_at
      ) VALUES ('controller-child', '実装子タスク', 'child', 'done', 'small', '#921',
        'controller-parent', '#920', 'directive-integrate', 'implement', ?, ?)`,
    ).run(now + 3, now + 3);
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, task_size, task_number,
        directive_id, controller_stage, created_at, updated_at
      ) VALUES ('controller-integrate', 'Integrate controller results', 'integrate', 'inbox', 'small', 'T02',
        'directive-integrate', 'integrate', ?, ?)`,
    ).run(now + 4, now + 4);

    const listRes = await fetch(`${baseUrl}/tasks?status=inbox`);
    assert.equal(listRes.status, 200);
    const tasks = (await listRes.json()) as Array<Record<string, unknown>>;
    const integrate = tasks.find((task) => task.id === "controller-integrate");

    assert.ok(integrate);
    assert.equal(integrate.parent_task_id, "controller-parent");
    assert.equal(integrate.parent_task_number, "#920");
    assert.equal(integrate.parent_task_title, "親のController作業");

    const detailRes = await fetch(`${baseUrl}/tasks/controller-integrate`);
    assert.equal(detailRes.status, 200);
    const detail = (await detailRes.json()) as Record<string, unknown>;
    assert.equal(detail.parent_task_id, "controller-parent");
    assert.equal(detail.parent_task_number, "#920");
    assert.equal(detail.parent_task_title, "親のController作業");
  });

  it("returns tasks ordered by priority DESC, created_at DESC", async () => {
    const res = await fetch(`${baseUrl}/tasks`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as Array<{ priority: number; created_at: number }>;
    for (let i = 1; i < tasks.length; i++) {
      const prev = tasks[i - 1]!;
      const curr = tasks[i]!;
      assert.ok(
        prev.priority > curr.priority ||
        (prev.priority === curr.priority && prev.created_at >= curr.created_at),
        "tasks should be ordered by priority DESC, then created_at DESC",
      );
    }
  });

  it("filters tasks by status query parameter", async () => {
    const res = await fetch(`${baseUrl}/tasks?status=done`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as Array<{ id: string; status: string }>;

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.id, "task-c");
    assert.equal(tasks[0]!.status, "done");
  });

  it("searches summary tasks by keyword across task metadata and heavy fields", async () => {
    db.prepare(
      `UPDATE tasks
       SET title = 'Fix onboarding search affordance',
           description = 'Includes a hidden nebula-keyword in the task body',
           result = 'Implemented search result polish',
           refinement_plan = 'Plan mentions quick task discovery',
           planned_files = ?,
           project_path = '/workspace/nebula-project',
           pr_url = 'https://github.com/org/repo/pull/123',
           repository_url = 'https://github.com/org/repo',
           external_source = 'linear',
           external_id = 'AO-123'
       WHERE id = 'task-a'`,
    ).run(JSON.stringify([{ path: "src/search.ts", action: "modify" }]));

    const titleRes = await fetch(`${baseUrl}/tasks?search=${encodeURIComponent("onboarding search")}`);
    assert.equal(titleRes.status, 200);
    const titleTasks = (await titleRes.json()) as Array<{ id: string }>;
    assert.deepEqual(titleTasks.map((task) => task.id), ["task-a"]);

    const descriptionRes = await fetch(`${baseUrl}/tasks?search=${encodeURIComponent("nebula-keyword")}`);
    assert.equal(descriptionRes.status, 200);
    const descriptionTasks = (await descriptionRes.json()) as Array<{ id: string }>;
    assert.deepEqual(descriptionTasks.map((task) => task.id), ["task-a"]);

    const plannedFilesRes = await fetch(`${baseUrl}/tasks?q=${encodeURIComponent("src/search.ts")}`);
    assert.equal(plannedFilesRes.status, 200);
    const plannedFilesTasks = (await plannedFilesRes.json()) as Array<{ id: string }>;
    assert.deepEqual(plannedFilesTasks.map((task) => task.id), ["task-a"]);
  });

  it("combines status and keyword task filters", async () => {
    db.prepare(
      `UPDATE tasks
       SET title = 'Shared search keyword active'
       WHERE id = 'task-a'`,
    ).run();
    db.prepare(
      `UPDATE tasks
       SET title = 'Shared search keyword complete'
       WHERE id = 'task-c'`,
    ).run();

    const res = await fetch(`${baseUrl}/tasks?status=done&search=${encodeURIComponent("Shared search keyword")}`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as Array<{ id: string; status: string }>;

    assert.deepEqual(tasks.map((task) => task.id), ["task-c"]);
    assert.equal(tasks[0]!.status, "done");
  });

  it("treats LIKE wildcard characters in task search as literal text", async () => {
    db.prepare(
      `UPDATE tasks SET title = 'Literal 100%_done marker' WHERE id = 'task-a'`,
    ).run();
    db.prepare(
      `UPDATE tasks SET title = 'Literal 100XYdone marker' WHERE id = 'task-b'`,
    ).run();

    const res = await fetch(`${baseUrl}/tasks?search=${encodeURIComponent("100%_")}`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as Array<{ id: string }>;

    assert.deepEqual(tasks.map((task) => task.id), ["task-a"]);
  });

  it("returns empty array when no tasks match the status filter", async () => {
    const res = await fetch(`${baseUrl}/tasks?status=cancelled`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as unknown[];
    assert.equal(tasks.length, 0);
  });

  it("returns all tasks when no status filter is provided", async () => {
    const res = await fetch(`${baseUrl}/tasks`);
    assert.equal(res.status, 200);
    const tasks = (await res.json()) as unknown[];
    assert.equal(tasks.length, 3);
  });
});

describe("GET /tasks/:id detail", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl = "";
  const taskId = "task-detail-1";

  beforeEach(async () => {
    db = createDb();
    insertTaskWithHeavyData(db, taskId);

    const app = express();
    app.use(express.json());
    app.use(createTasksRouter({ db, ws: { broadcast() {} } as never }));

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    clearPendingInteractivePrompt(taskId);
    db.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("includes all columns including heavy ones", async () => {
    const res = await fetch(`${baseUrl}/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const task = (await res.json()) as Record<string, unknown>;

    for (const col of SUMMARY_COLUMNS) {
      assert.ok(col in task, `GET /tasks/:id should include '${col}'`);
    }
    for (const col of HEAVY_COLUMNS) {
      assert.ok(col in task, `GET /tasks/:id should include '${col}'`);
    }
  });

  it("returns description content in the detail response", async () => {
    const res = await fetch(`${baseUrl}/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const task = (await res.json()) as { description: string };
    assert.ok(task.description.includes("A long description"));
  });

  it("returns refinement_plan content in the detail response", async () => {
    const res = await fetch(`${baseUrl}/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const task = (await res.json()) as { refinement_plan: string };
    assert.ok(task.refinement_plan.includes("Refinement Plan"));
  });

  it("returns result content in the detail response", async () => {
    const res = await fetch(`${baseUrl}/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const task = (await res.json()) as { result: string };
    assert.ok(task.result.includes("Task result output"));
  });

  it("returns 404 for a non-existent task", async () => {
    const res = await fetch(`${baseUrl}/tasks/non-existent-id`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "not_found");
  });
});

describe("GET /tasks payload size reduction", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl = "";
  const taskIds: string[] = [];

  beforeEach(async () => {
    db = createDb();
    for (let i = 0; i < 10; i++) {
      const id = `task-size-${i}`;
      insertTaskWithHeavyData(db, id);
      taskIds.push(id);
    }

    const app = express();
    app.use(express.json());
    app.use(createTasksRouter({ db, ws: { broadcast() {} } as never }));

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const id of taskIds) clearPendingInteractivePrompt(id);
    taskIds.length = 0;
    db.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("summary payload is significantly smaller than full detail payload", async () => {
    const summaryRes = await fetch(`${baseUrl}/tasks`);
    const summaryBody = await summaryRes.text();

    let detailTotalSize = 0;
    for (const id of taskIds) {
      const detailRes = await fetch(`${baseUrl}/tasks/${id}`);
      const detailBody = await detailRes.text();
      detailTotalSize += detailBody.length;
    }

    const summarySize = summaryBody.length;
    const ratio = summarySize / detailTotalSize;
    assert.ok(
      ratio < 0.5,
      `Summary payload (${summarySize} bytes) should be <50% of full detail payload (${detailTotalSize} bytes), but ratio was ${(ratio * 100).toFixed(1)}%`,
    );
  });
});
