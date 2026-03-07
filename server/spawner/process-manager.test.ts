import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import { determineCompletionStatus } from "./process-manager.js";
import type { Task } from "../types/runtime.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec("ALTER TABLE tasks ADD COLUMN interactive_prompt_data TEXT");
  return db;
}

function insertTask(db: DatabaseSync, overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: "task-1",
    title: "Test task",
    description: null,
    assigned_agent_id: null,
    project_path: null,
    status: "in_progress",
    priority: 0,
    task_size: "medium",
    task_number: "#1",
    depends_on: null,
    result: null,
    pr_url: null,
    review_count: 0,
    directive_id: null,
    started_at: 2_000,
    completed_at: null,
    created_at: 1_000,
    updated_at: 2_000,
    ...overrides,
    external_source: overrides.external_source ?? null,
    external_id: overrides.external_id ?? null,
  };

  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, project_path, status, priority, task_size,
      task_number, depends_on, result, review_count, started_at, completed_at, created_at, updated_at,
      directive_id, pr_url, interactive_prompt_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    task.id,
    task.title,
    task.description,
    task.assigned_agent_id,
    task.project_path,
    task.status,
    task.priority,
    task.task_size,
    task.task_number,
    task.depends_on,
    task.result,
    task.review_count,
    task.started_at,
    task.completed_at,
    task.created_at,
    task.updated_at,
    task.directive_id,
    task.pr_url
  );

  return task;
}

function insertStdoutLog(db: DatabaseSync, taskId: string, message: string, createdAt: number): void {
  db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)")
    .run(taskId, message, createdAt);
}

function insertAssistantLog(db: DatabaseSync, taskId: string, message: string, createdAt: number): void {
  db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'assistant', ?, ?)")
    .run(taskId, message, createdAt);
}

describe("determineCompletionStatus", () => {
  it("ignores old review logs from previous runs", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 3, started_at: 10_000 });

    insertStdoutLog(db, task.id, "[REVIEW:NEEDS_CHANGES]", 5_000);
    insertStdoutLog(db, task.id, "[REVIEW:PASS]", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "done");
  });

  it("still returns inbox when current run requests changes", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 2, started_at: 10_000 });

    insertAssistantLog(db, task.id, "[REVIEW:NEEDS_CHANGES]", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "inbox");
  });

  it("ignores old self-review logs from previous runs", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 0, started_at: 10_000, task_size: "small" });

    insertStdoutLog(db, task.id, "[SELF_REVIEW:PASS]", 5_000);

    const status = determineCompletionStatus(db, task, true);
    assert.equal(status, "pr_review");
  });

  it("ignores review markers that only appear inside stdout tool results", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 4, started_at: 10_000 });

    insertStdoutLog(db, task.id, '{"type":"user","message":{"content":"preview [REVIEW:NEEDS_CHANGES]"}}', 11_000);
    insertAssistantLog(db, task.id, "レビュー結果です\n[REVIEW:PASS]", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "done");
  });
});
