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
  "planned_files",
  "interactive_prompt_data",
  "repository_urls",
  "pr_urls",
  "merged_pr_urls",
] as const;

const SUMMARY_COLUMNS = [
  "id", "title", "assigned_agent_id", "project_path", "status",
  "priority", "task_size", "task_number", "depends_on",
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
