import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import {
  buildRefinementRevisionPrompt,
  determineCompletionStatus,
  extractGithubArtifactsFromLogs,
  extractRefinementPlanFromLogs,
  isReviewRunTask,
  persistRefinementPlanExtraction,
  resolveCompletionStatusAfterPromotion,
} from "./process-manager.js";
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
    refinement_plan: null,
    refinement_completed_at: null,
    planned_files: null,
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
    repository_url: null,
    repository_urls: null,
    pr_urls: null,
    merged_pr_urls: null,
    settings_overrides: null,
    started_at: 2_000,
    completed_at: null,
    auto_respawn_count: 0,
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

function insertLog(
  db: DatabaseSync,
  taskId: string,
  kind: "stdout" | "assistant" | "tool_result" | "tool_call" | "system",
  message: string,
  createdAt: number,
): void {
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)",
  ).run(taskId, kind, message, createdAt);
}

describe("extractGithubArtifactsFromLogs", () => {
  it("returns nulls when no GitHub URL appears in any log", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t1" });
    insertLog(db, task.id, "stdout", "ls /tmp", 10);
    insertLog(db, task.id, "assistant", "Running tests locally.", 20);
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, null);
    assert.equal(result.repositoryUrl, null);
  });

  it("extracts a PR URL and derives the repository URL from it", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t2" });
    insertLog(
      db,
      task.id,
      "stdout",
      "Created pull request: https://github.com/acme/widget/pull/42",
      100,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, "https://github.com/acme/widget/pull/42");
    assert.equal(result.repositoryUrl, "https://github.com/acme/widget");
  });

  it("picks the most frequently referenced PR URL", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t3" });
    // Stale mention from earlier reasoning
    insertLog(
      db,
      task.id,
      "assistant",
      "Earlier I worked on https://github.com/acme/widget/pull/10",
      10,
    );
    // New PR created three times across different log kinds
    insertLog(
      db,
      task.id,
      "stdout",
      "https://github.com/acme/widget/pull/42 is ready for review",
      20,
    );
    insertLog(
      db,
      task.id,
      "assistant",
      "PR URL: https://github.com/acme/widget/pull/42",
      30,
    );
    insertLog(
      db,
      task.id,
      "tool_result",
      "{\"url\":\"https://github.com/acme/widget/pull/42\"}",
      40,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, "https://github.com/acme/widget/pull/42");
    assert.equal(result.repositoryUrl, "https://github.com/acme/widget");
  });

  it("falls back to a repository URL when no PR was mentioned", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t4" });
    insertLog(
      db,
      task.id,
      "stdout",
      "origin\thttps://github.com/acme/widget.git (fetch)",
      10,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, null);
    assert.equal(result.repositoryUrl, "https://github.com/acme/widget");
  });

  it("ignores non-repo GitHub URLs like /orgs/, /search/, /notifications", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t5" });
    insertLog(
      db,
      task.id,
      "assistant",
      "Checking https://github.com/notifications and https://github.com/search?q=test",
      10,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, null);
    assert.equal(result.repositoryUrl, null);
  });

  it("strips a trailing .git suffix from repository URLs", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t6" });
    insertLog(
      db,
      task.id,
      "stdout",
      "git clone https://github.com/acme/widget.git",
      10,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.repositoryUrl, "https://github.com/acme/widget");
  });

  // ---- Stage 1: command-linked extraction ----

  it("stage 1: extracts PR URL from tool_result following gh pr create tool_call", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t7" });
    insertLog(db, task.id, "tool_call", "shell(gh pr create --title 'feat: widget')", 10);
    insertLog(
      db,
      task.id,
      "tool_result",
      "shell(gh pr create ...) → https://github.com/acme/widget/pull/99",
      11,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, "https://github.com/acme/widget/pull/99");
    assert.equal(result.repositoryUrl, "https://github.com/acme/widget");
  });

  it("stage 1: extracts repository URL from tool_result following gh repo create tool_call", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t8" });
    insertLog(db, task.id, "tool_call", "shell(gh repo create acme/new-lib --public)", 10);
    insertLog(
      db,
      task.id,
      "tool_result",
      "shell(gh repo create ...) → https://github.com/acme/new-lib",
      11,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, null);
    assert.equal(result.repositoryUrl, "https://github.com/acme/new-lib");
  });

  it("stage 1: command-linked result wins over frequency-ranked noise elsewhere", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t9" });
    // Massive stale-reference noise in earlier reasoning — 10 mentions
    // of an unrelated PR the agent was only reading.
    for (let i = 0; i < 10; i++) {
      insertLog(
        db,
        task.id,
        "assistant",
        "Referencing past work at https://github.com/old/project/pull/1",
        5 + i,
      );
    }
    // The real creation is a single tool_call → tool_result pair.
    insertLog(db, task.id, "tool_call", "shell(gh pr create --title 'new')", 100);
    insertLog(
      db,
      task.id,
      "tool_result",
      "shell(gh pr create ...) → https://github.com/new/repo/pull/42",
      101,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, "https://github.com/new/repo/pull/42");
    assert.equal(result.repositoryUrl, "https://github.com/new/repo");
  });

  it("stage 1: allows intervening rows within the command window", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t10" });
    insertLog(db, task.id, "tool_call", "shell(gh pr create --title 'x')", 10);
    // A couple of intervening thinking/assistant events before the
    // actual command output.
    insertLog(db, task.id, "assistant", "Waiting for gh to respond...", 11);
    insertLog(db, task.id, "stdout", "some unrelated log", 12);
    insertLog(
      db,
      task.id,
      "tool_result",
      "shell(gh pr create ...) → https://github.com/acme/widget/pull/77",
      13,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, "https://github.com/acme/widget/pull/77");
  });

  // ---- Stage 2: noise filtering ----

  it("stage 2: ignores URLs embedded in doubly-stringified transcript blobs", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t11" });
    // This is the #355 calculator-task failure mode: agent CLI verbose
    // logs land in stdout with escape-on-escape JSON that references a
    // sibling directory / past task. The URL must NOT be picked up.
    const noise =
      '{\\"type\\":\\"user\\",\\"message\\":{\\"content\\":[{\\"tool_use_id\\":\\"toolu_1\\",\\"content\\":\\"File created successfully at: /home/mk/workspace/verify2-charcount-cli/.gitignore. See https://github.com/1neoneo3/verify2-charcount-cli/pull/1\\"}]}}';
    // Insert it 50 times to simulate the real frequency-domination.
    for (let i = 0; i < 50; i++) {
      insertLog(db, task.id, "stdout", noise, 100 + i);
    }
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, null);
    assert.equal(result.repositoryUrl, null);
  });

  it("stage 2: ignores URLs appearing only in tool_call rows (e.g. gh pr view)", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t12" });
    // The agent runs `gh pr view <url>` to inspect an existing PR.
    // That URL must not be recorded as the task's own created artifact.
    insertLog(
      db,
      task.id,
      "tool_call",
      "shell(gh pr view https://github.com/acme/other/pull/1 --json title)",
      10,
    );
    insertLog(
      db,
      task.id,
      "tool_result",
      "shell(gh pr view ...) → {\"title\":\"something\"}",
      11,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, null);
    assert.equal(result.repositoryUrl, null);
  });

  it("stage 2: accepts clean assistant summary when no creation command is visible", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t13" });
    // Legacy signal path: agent summarises the PR it just created in
    // plain assistant text without a matching tool_call we can hook.
    insertLog(
      db,
      task.id,
      "assistant",
      "PR URL: https://github.com/acme/widget/pull/55",
      10,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id);
    assert.equal(result.prUrl, "https://github.com/acme/widget/pull/55");
    assert.equal(result.repositoryUrl, "https://github.com/acme/widget");
  });

  // ---- runStartedAt windowing ----

  it("runStartedAt: ignores log rows from before the current run", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t14", started_at: 10_000 });
    // Stale row from a previous run (before started_at).
    insertLog(
      db,
      task.id,
      "assistant",
      "Created pull request: https://github.com/acme/old/pull/1",
      5_000,
    );
    // Current run has no github artefacts.
    insertLog(db, task.id, "assistant", "Working locally only.", 12_000);
    const result = extractGithubArtifactsFromLogs(db, task.id, { runStartedAt: 10_000 });
    assert.equal(result.prUrl, null);
    assert.equal(result.repositoryUrl, null);
  });

  it("runStartedAt: accepts log rows from the current run only", () => {
    const db = createDb();
    const task = insertTask(db, { id: "t15", started_at: 10_000 });
    insertLog(db, task.id, "assistant", "Old run: https://github.com/acme/old/pull/1", 5_000);
    insertLog(
      db,
      task.id,
      "assistant",
      "Created pull request: https://github.com/acme/new/pull/2",
      12_000,
    );
    const result = extractGithubArtifactsFromLogs(db, task.id, { runStartedAt: 10_000 });
    assert.equal(result.prUrl, "https://github.com/acme/new/pull/2");
    assert.equal(result.repositoryUrl, "https://github.com/acme/new");
  });
});

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

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "done");
  });

  it("returns in_progress when current run requests changes", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 2, started_at: 10_000 });

    insertAssistantLog(db, task.id, "[REVIEW:NEEDS_CHANGES]", 12_000);

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "in_progress");
  });

  it("returns in_progress when pr_review run has no verdict tag (no implicit pass)", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 2, started_at: 10_000 });

    insertAssistantLog(db, task.id, "レビューしましたが判定タグを出力し忘れました", 12_000);

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "in_progress");
  });

  it("ignores legacy auto_done setting and never implicitly passes pr_review", () => {
    const db = createDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('auto_done', 'true')").run();
    const task = insertTask(db, { review_count: 2, started_at: 10_000 });

    insertAssistantLog(db, task.id, "レビュー完了（タグなし）", 12_000);

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "in_progress");
  });

  it("returns done when ci_check run outputs [CI_CHECK:PASS]", () => {
    const db = createDb();
    const task = insertTask(db, { status: "ci_check", review_count: 0, started_at: 10_000 });

    insertAssistantLog(db, task.id, "全チェック通過しました\n[CI_CHECK:PASS]", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "done");
  });

  it("returns in_progress when ci_check run outputs [CI_CHECK:FAIL]", () => {
    const db = createDb();
    const task = insertTask(db, { status: "ci_check", review_count: 0, started_at: 10_000 });

    insertAssistantLog(db, task.id, "[CI_CHECK:FAIL:no CI workflow found]", 12_000);

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "in_progress");
  });

  it("returns in_progress when ci_check run has no verdict tag (no implicit pass)", () => {
    const db = createDb();
    const task = insertTask(db, { status: "ci_check", review_count: 0, started_at: 10_000 });

    insertAssistantLog(db, task.id, "CI確認を実施しましたが判定タグ未出力", 12_000);

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "in_progress");
  });

  it("ignores old self-review logs from previous runs", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 0, started_at: 10_000, task_size: "small" });

    insertStdoutLog(db, task.id, "[SELF_REVIEW:PASS]", 5_000);

    const status = determineCompletionStatus(db, task, true);
    assert.equal(status, "in_progress");
  });

  it("ignores review markers that only appear inside stdout tool results", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 4, started_at: 10_000 });

    insertStdoutLog(db, task.id, '{"type":"user","message":{"content":"preview [REVIEW:NEEDS_CHANGES]"}}', 11_000);
    insertAssistantLog(db, task.id, "レビュー結果です\n[REVIEW:PASS]", 12_000);

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "done");
  });

  it("sends inbox reruns with prior reviews back to pr_review after implementation succeeds", () => {
    const db = createDb();
    const task = insertTask(db, { status: "inbox", review_count: 5, started_at: 10_000 });

    insertAssistantLog(db, task.id, "実装修正を反映しました。", 12_000);

    const status = determineCompletionStatus(db, task, false, false);
    assert.equal(status, "pr_review");
  });

  it("does not infer a review run from review_count on implementation completion", () => {
    const db = createDb();
    const task = insertTask(db, { status: "in_progress", review_count: 2, started_at: 10_000 });

    insertAssistantLog(db, task.id, "[REVIEW:NEEDS_CHANGES]", 12_000);

    const status = determineCompletionStatus(db, task, false);
    assert.equal(status, "pr_review");
  });

  // --- Role-tagged verdict tests (parallel review panel) ---

  it("passes when both code and security role-tagged verdicts are PASS", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 1, started_at: 10_000 });

    // Panel marker tells aggregation which roles to expect
    insertLog(db, task.id, "system", "[REVIEWER_PANEL:code,security]", 10_500);
    insertAssistantLog(db, task.id, "[REVIEW:code:PASS]", 12_000);
    insertAssistantLog(db, task.id, "[REVIEW:security:PASS]", 13_000);

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "done");
  });

  it("returns in_progress when security reviewer requests changes despite code pass", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 1, started_at: 10_000 });

    insertLog(db, task.id, "system", "[REVIEWER_PANEL:code,security]", 10_500);
    insertAssistantLog(db, task.id, "[REVIEW:code:PASS]", 12_000);
    insertAssistantLog(db, task.id, "[REVIEW:security:NEEDS_CHANGES:SQL injection in query builder]", 13_000);

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "in_progress");
  });

  it("returns in_progress when code reviewer requests changes despite security pass", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 1, started_at: 10_000 });

    insertLog(db, task.id, "system", "[REVIEWER_PANEL:code,security]", 10_500);
    insertAssistantLog(db, task.id, "[REVIEW:code:NEEDS_CHANGES:poor error handling]", 12_000);
    insertAssistantLog(db, task.id, "[REVIEW:security:PASS]", 13_000);

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "in_progress");
  });

  it("returns in_progress when panel expects two roles but only code verdict arrives", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 1, started_at: 10_000 });

    insertLog(db, task.id, "system", "[REVIEWER_PANEL:code,security]", 10_500);
    insertAssistantLog(db, task.id, "[REVIEW:code:PASS]", 12_000);
    // security verdict never arrives (agent crashed or timed out)

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "in_progress");
  });

  it("legacy [REVIEW:PASS] still works when no panel marker exists", () => {
    const db = createDb();
    const task = insertTask(db, { review_count: 2, started_at: 10_000 });

    // No [REVIEWER_PANEL:...] marker — legacy single-reviewer flow
    insertAssistantLog(db, task.id, "[REVIEW:PASS]", 12_000);

    const status = determineCompletionStatus(db, task, false, true);
    assert.equal(status, "done");
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

// Helper: insert an assistant-kind log with explicit stage + created_at
// (mimics how PR 1's spawnAgent now tags every insert).
function insertStagedAssistantLog(
  db: DatabaseSync,
  taskId: string,
  stage: string,
  message: string,
  createdAt: number,
): void {
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'assistant', ?, ?, ?)",
  ).run(taskId, message, stage, createdAt);
}

describe("extractRefinementPlanFromLogs", () => {
  it("returns the marker-bounded plan when the canonical block is present", () => {
    const db = createDb();
    const task = insertTask(db, { id: "tplan", started_at: 1_000 });
    insertStagedAssistantLog(
      db,
      task.id,
      "refinement",
      "---REFINEMENT PLAN---\n## Requirements\n- X\n- Y\n---END REFINEMENT---",
      2_000,
    );

    const result = extractRefinementPlanFromLogs(db, task.id, 1_500);
    assert.equal(result.kind, "plan");
    if (result.kind === "plan") {
      assert.match(result.plan, /---REFINEMENT PLAN---/);
      assert.match(result.plan, /---END REFINEMENT---/);
      assert.match(result.plan, /## Requirements/);
    }
  });

  it("falls back to the last 5000 chars when markers are missing but agent produced output", () => {
    const db = createDb();
    const task = insertTask(db, { id: "tfb", started_at: 1_000 });
    insertStagedAssistantLog(db, task.id, "refinement", "no markers here, just prose.", 2_000);

    const result = extractRefinementPlanFromLogs(db, task.id, 1_500);
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") {
      assert.equal(result.plan, "no markers here, just prose.");
    }
  });

  it("returns 'empty' when no assistant logs exist since spawnStartedAt", () => {
    const db = createDb();
    const task = insertTask(db, { id: "tempty", started_at: 1_000 });
    // Log from BEFORE the current spawn — must be excluded.
    insertStagedAssistantLog(db, task.id, "refinement", "old run output", 500);

    const result = extractRefinementPlanFromLogs(db, task.id, 1_500);
    assert.equal(result.kind, "empty");
  });

  it("excludes non-refinement stages even when kind='assistant'", () => {
    // This is the Bug 2 regression: previously the extraction query had
    // no stage filter, so in_progress / pr_review logs could bleed in.
    const db = createDb();
    const task = insertTask(db, { id: "tbleed", started_at: 1_000 });
    insertStagedAssistantLog(db, task.id, "in_progress", "implementation notes", 2_000);
    insertStagedAssistantLog(db, task.id, "pr_review", "[REVIEW:code:PASS]", 2_500);

    const result = extractRefinementPlanFromLogs(db, task.id, 1_500);
    // No refinement-stage logs → empty (NOT fallback with bled-in content).
    assert.equal(result.kind, "empty");
  });

  it("ignores refinement logs created before spawnStartedAt (previous run)", () => {
    const db = createDb();
    const task = insertTask(db, { id: "tprev", started_at: 1_000 });
    insertStagedAssistantLog(
      db,
      task.id,
      "refinement",
      "---REFINEMENT PLAN---\nfrom previous run\n---END REFINEMENT---",
      500,
    );
    insertStagedAssistantLog(
      db,
      task.id,
      "refinement",
      "---REFINEMENT PLAN---\nfrom current run\n---END REFINEMENT---",
      2_000,
    );

    const result = extractRefinementPlanFromLogs(db, task.id, 1_500);
    assert.equal(result.kind, "plan");
    if (result.kind === "plan") {
      assert.match(result.plan, /from current run/);
      assert.doesNotMatch(result.plan, /from previous run/);
    }
  });

  it("captures logs inserted via DEFAULT created_at within the same wall-second (precision alignment)", () => {
    // Regression test for Bug 2's second-precision trap: task_logs.created_at
    // defaults to `unixepoch() * 1000` (second-granular ms, sub-second
    // portion always zero). If `spawnStartedAt` is captured as raw
    // `Date.now()`, it is up to 999ms ahead of the DEFAULT, which
    // excludes any log inserted inside the same wall-second as the
    // spawn — exactly when refinement agents emit their first output.
    // spawnAgent now floors `Date.now()` to the second so the `>=`
    // filter is inclusive. This test locks that invariant in.
    const db = createDb();
    const task = insertTask(db, { id: "tprec" });
    const spawnStartedAt = Math.floor(Date.now() / 1000) * 1000;

    // Production-path insert: rely on DEFAULT created_at. No explicit
    // created_at argument — this is what the real insertLogStmt does.
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage) VALUES (?, 'assistant', ?, 'refinement')",
    ).run(task.id, "---REFINEMENT PLAN---\nX\n---END REFINEMENT---");

    const result = extractRefinementPlanFromLogs(db, task.id, spawnStartedAt);
    assert.equal(result.kind, "plan", "plan must be captured even when created_at == floor(spawnStartedAt)");
  });

  it("returns the LAST plan block when agent emits multiple drafts", () => {
    const db = createDb();
    const task = insertTask(db, { id: "tmulti" });
    insertStagedAssistantLog(
      db,
      task.id,
      "refinement",
      "---REFINEMENT PLAN---\nDRAFT v1\n---END REFINEMENT---\n\nOn second thought...\n\n" +
        "---REFINEMENT PLAN---\nFINAL v2\n---END REFINEMENT---",
      2_000,
    );

    const result = extractRefinementPlanFromLogs(db, task.id, 1_500);
    assert.equal(result.kind, "plan");
    if (result.kind === "plan") {
      assert.match(result.plan, /FINAL v2/);
      assert.doesNotMatch(result.plan, /DRAFT v1/);
    }
  });
});

describe("buildRefinementRevisionPrompt", () => {
  it("asks the resumed refinement agent to emit a complete canonical plan", () => {
    const prompt = buildRefinementRevisionPrompt("Add test coverage to the implementation plan.");

    assert.match(prompt, /complete updated implementation plan/);
    assert.match(prompt, /---REFINEMENT PLAN---/);
    assert.match(prompt, /---END REFINEMENT---/);
    assert.match(prompt, /Add test coverage/);
  });
});

describe("persistRefinementPlanExtraction", () => {
  it("overwrites an existing implementation plan with the revised canonical plan", () => {
    const db = createDb();
    const task = insertTask(db, { id: "trevise", status: "refinement" });
    db.prepare(
      `UPDATE tasks
       SET refinement_plan = ?,
           refinement_completed_at = ?,
           refinement_revision_requested_at = ?
       WHERE id = ?`,
    ).run("---REFINEMENT PLAN---\nOLD PLAN\n---END REFINEMENT---", 1_000, 4_000, task.id);

    const revisedPlan = [
      "---REFINEMENT PLAN---",
      "## Requirements",
      "- Revised requirement",
      "",
      "## Files to Modify",
      "- `src/revised.ts` — update behavior",
      "",
      "## Implementation Plan",
      "1. Implement revised behavior",
      "---END REFINEMENT---",
    ].join("\n");

    persistRefinementPlanExtraction(
      db,
      task.id,
      { kind: "plan", plan: revisedPlan },
      { stage: "refinement", agentId: "agent-1", now: 5_000 },
    );

    const row = db.prepare(
      `SELECT refinement_plan,
              refinement_completed_at,
              refinement_revision_completed_at,
              planned_files
       FROM tasks
       WHERE id = ?`,
    ).get(task.id) as {
      refinement_plan: string | null;
      refinement_completed_at: number | null;
      refinement_revision_completed_at: number | null;
      planned_files: string | null;
    };

    assert.equal(row.refinement_plan, revisedPlan);
    assert.equal(row.refinement_completed_at, 5_000);
    assert.equal(row.refinement_revision_completed_at, 5_000);
    assert.deepEqual(JSON.parse(row.planned_files ?? "[]"), ["src/revised.ts"]);
  });

  it("preserves an existing plan when a revision run has only markerless fallback output", () => {
    const db = createDb();
    const task = insertTask(db, { id: "tfallback-revise", status: "refinement" });
    const existingPlan = "---REFINEMENT PLAN---\nOLD PLAN\n---END REFINEMENT---";
    db.prepare(
      "UPDATE tasks SET refinement_plan = ?, refinement_completed_at = ? WHERE id = ?",
    ).run(existingPlan, 1_000, task.id);

    persistRefinementPlanExtraction(
      db,
      task.id,
      { kind: "fallback", plan: "markerless prose" },
      { stage: "refinement", agentId: "agent-1", now: 5_000 },
    );

    const row = db.prepare(
      "SELECT refinement_plan FROM tasks WHERE id = ?",
    ).get(task.id) as { refinement_plan: string | null };
    const log = db.prepare(
      "SELECT message, stage, agent_id FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY id DESC LIMIT 1",
    ).get(task.id) as { message: string; stage: string | null; agent_id: string | null };

    assert.equal(row.refinement_plan, existingPlan);
    assert.match(log.message, /existing refinement_plan preserved/);
    assert.equal(log.stage, "refinement");
    assert.equal(log.agent_id, "agent-1");
  });
});
