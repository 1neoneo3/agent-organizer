import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import { determineCompletionStatus, isReviewRunTask, resolveCompletionStatusAfterPromotion } from "./process-manager.js";
import type { Task } from "../types/runtime.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
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
    external_source: null,
    external_id: null,
    review_count: 0,
    directive_id: null,
    interactive_prompt_data: null,
    review_branch: null,
    review_commit_sha: null,
    review_sync_status: "pending",
    review_sync_error: null,
    started_at: 2_000,
    completed_at: null,
    created_at: 1_000,
    updated_at: 2_000,
    ...overrides,
  };

  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, project_path, status, priority, task_size,
      task_number, depends_on, result, review_count, started_at, completed_at, created_at, updated_at,
      directive_id, pr_url, external_source, external_id, interactive_prompt_data,
      review_branch, review_commit_sha, review_sync_status, review_sync_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    task.pr_url,
    task.external_source,
    task.external_id,
    task.interactive_prompt_data,
    task.review_branch,
    task.review_commit_sha,
    task.review_sync_status,
    task.review_sync_error,
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

describe("isReviewRunTask", () => {
  it("treats pr_review tasks as review runs", () => {
    const task = insertTask(createDb(), { status: "pr_review", review_count: 1 });
    assert.equal(isReviewRunTask(task), true);
  });

  it("does not treat inbox reruns as review runs just because review_count is non-zero", () => {
    const task = insertTask(createDb(), { status: "inbox", review_count: 3 });
    assert.equal(isReviewRunTask(task), false);
  });

  it("keeps review mode when resuming from an interactive prompt raised during pr_review", () => {
    const task = insertTask(createDb(), { status: "in_progress", review_count: 3 });
    assert.equal(isReviewRunTask(task, "pr_review"), true);
  });
});

describe("determineCompletionStatus", () => {
  it("ignores old review logs from previous runs", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 3, started_at: 10_000 });

    // Log from a previous run (before started_at) should be ignored.
    insertAssistantLog(db, task.id, "[REVIEW:NEEDS_CHANGES]", 5_000);
    // Log from the current run decides the verdict.
    insertAssistantLog(db, task.id, "[REVIEW:PASS]", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "done");
  });

  it("returns in_progress when current run requests changes", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 2, started_at: 10_000 });

    insertAssistantLog(db, task.id, "[REVIEW:NEEDS_CHANGES]", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "in_progress");
  });

  it("returns in_progress when pr_review run has no verdict tag (no implicit pass)", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 2, started_at: 10_000 });

    insertAssistantLog(db, task.id, "レビューしましたが判定タグを出力し忘れました", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "in_progress");
  });

  it("ignores legacy auto_done setting and never implicitly passes pr_review", () => {
    const db = createDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('auto_done', 'true')").run();
    const task = insertTask(db, { review_count: 2, started_at: 10_000 });

    insertAssistantLog(db, task.id, "レビュー完了（タグなし）", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "in_progress");
  });

  it("returns done when pre_deploy run outputs [PRE_DEPLOY:PASS]", () => {
    const db = createDb();
    const task = insertTask(db, { status: "pre_deploy", review_count: 0, started_at: 10_000 });

    insertAssistantLog(db, task.id, "全チェック通過しました\n[PRE_DEPLOY:PASS]", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "done");
  });

  it("returns pr_review when pre_deploy run outputs [PRE_DEPLOY:FAIL]", () => {
    const db = createDb();
    const task = insertTask(db, { status: "pre_deploy", review_count: 0, started_at: 10_000 });

    insertAssistantLog(db, task.id, "[PRE_DEPLOY:FAIL:migration check failed]", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "pr_review");
  });

  it("returns pr_review when pre_deploy run has no verdict tag (no implicit pass)", () => {
    const db = createDb();
    const task = insertTask(db, { status: "pre_deploy", review_count: 0, started_at: 10_000 });

    insertAssistantLog(db, task.id, "事前チェックを実施しましたが判定タグ未出力", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "pr_review");
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

  it("sends inbox reruns with prior reviews back to pr_review after implementation succeeds", () => {
    const db = createDb();
    const task = insertTask(db, { status: "inbox", review_count: 5, started_at: 10_000 });

    insertAssistantLog(db, task.id, "実装修正を反映しました。", 12_000);

    const status = determineCompletionStatus(db, task, false, false);
    assert.equal(status, "pr_review");
  });
});

describe("resolveCompletionStatusAfterPromotion", () => {
  it("keeps a reviewed task in pr_review when push failed", () => {
    const task = insertTask(createDb(), { status: "pr_review", review_count: 1 });

    const resolution = resolveCompletionStatusAfterPromotion(task, "done", false, true, {
      branchName: "issue/t1",
      commitSha: "abc123",
      prUrl: null,
      syncStatus: "local_commit_ready",
      syncError: "push failed: Could not resolve host: github.com",
      baseBranch: "main",
    });

    assert.equal(resolution.status, "pr_review");
    assert.match(resolution.blockedReason ?? "", /push failed/);
  });

  it("keeps implementation tasks incomplete when review metadata is missing", () => {
    const task = insertTask(createDb(), { status: "in_progress", review_count: 0 });

    const resolution = resolveCompletionStatusAfterPromotion(task, "pr_review", false, false, {
      branchName: "issue/t2",
      commitSha: "def456",
      prUrl: null,
      syncStatus: "pushed",
      syncError: null,
      baseBranch: "main",
    });

    assert.equal(resolution.status, "inbox");
    assert.match(resolution.blockedReason ?? "", /pr_url/);
  });

  it("allows completion when review artifact sync is fully ready", () => {
    const task = insertTask(createDb(), { status: "pr_review", review_count: 1 });

    const resolution = resolveCompletionStatusAfterPromotion(task, "done", false, true, {
      branchName: "issue/t3",
      commitSha: "ghi789",
      prUrl: "https://github.com/example/repo/pull/3",
      syncStatus: "pr_open",
      syncError: null,
      baseBranch: "main",
    });

    assert.equal(resolution.status, "done");
    assert.equal(resolution.blockedReason, null);
  });
});
