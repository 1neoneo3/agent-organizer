import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../types/runtime.js";
import type { ProjectWorkflow } from "./loader.js";

/**
 * Ordered workflow stages from start to completion.
 * Each stage must be completed before moving to the next.
 */
const WORKFLOW_STAGES = [
  "in_progress",
  "test_generation",
  "qa_testing",
  "pr_review",
  "human_review",
  "pre_deploy",
  "done",
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Resolve which stages are active based on workflow config and settings.
 * Stages that are disabled are skipped in the pipeline.
 */
export function resolveActiveStages(
  db: DatabaseSync,
  workflow: ProjectWorkflow | null,
): WorkflowStage[] {
  const qaMode = getSetting(db, "qa_mode") ?? "disabled";
  const reviewMode = getSetting(db, "review_mode") ?? "pr_only";

  const stages: WorkflowStage[] = ["in_progress"];

  // test_generation: controlled by workflow config
  if (workflow?.enableTestGeneration) {
    stages.push("test_generation");
  }

  // qa_testing: controlled by settings (qa_mode)
  if (qaMode === "enabled") {
    stages.push("qa_testing");
  }

  // pr_review: controlled by settings (review_mode)
  if (reviewMode !== "none") {
    stages.push("pr_review");
  }

  // human_review: controlled by workflow config
  if (workflow?.enableHumanReview) {
    stages.push("human_review");
  }

  // pre_deploy: controlled by workflow config
  if (workflow?.enablePreDeploy) {
    stages.push("pre_deploy");
  }

  stages.push("done");

  return stages;
}

/**
 * Find the last failed stage for a task by scanning task_logs for [FAIL_AT:*] markers.
 * Returns the stage name if found, or null if no failure marker exists.
 */
export function findLastFailedStage(
  db: DatabaseSync,
  taskId: string,
): WorkflowStage | null {
  const row = db
    .prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '[FAIL_AT:%' ORDER BY created_at DESC LIMIT 1",
    )
    .get(taskId) as { message: string } | undefined;

  if (!row) return null;

  const match = row.message.match(/\[FAIL_AT:(\w+)\]/);
  if (!match) return null;

  const stage = match[1] as WorkflowStage;
  if (WORKFLOW_STAGES.includes(stage)) return stage;
  return null;
}

/**
 * Record a failure marker in task_logs so the task can resume from this stage.
 */
export function recordFailedStage(
  db: DatabaseSync,
  taskId: string,
  stage: WorkflowStage,
): void {
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
  ).run(taskId, `[FAIL_AT:${stage}] Stage failed. Task will resume from this stage after rework.`);
}

/**
 * Clear the failure marker when a task successfully passes the previously failed stage.
 */
export function clearFailedStage(
  db: DatabaseSync,
  taskId: string,
): void {
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
  ).run(taskId, "[FAIL_AT:CLEARED] Previous failure marker cleared. Resuming normal pipeline.");
}

/**
 * Determine the next stage after the current one completes successfully.
 * If the current stage is not in the active pipeline, falls back to "done".
 */
export function nextStage(
  current: Task["status"],
  activeStages: WorkflowStage[],
): WorkflowStage {
  const currentIndex = activeStages.indexOf(current as WorkflowStage);

  // Current stage not in pipeline — go to done
  if (currentIndex === -1) return "done";

  // Already at last stage
  if (currentIndex >= activeStages.length - 1) return "done";

  return activeStages[currentIndex + 1];
}

/**
 * Determine the next stage for a task that just completed its current run.
 * This replaces the old determineCompletionStatus logic with a pipeline-aware version.
 *
 * @param db - Database connection
 * @param task - The task that just completed
 * @param selfReview - Whether the run was a self-review
 * @param reviewRun - Whether the run was a review run
 * @param workflow - The project workflow config (from WORKFLOW.md)
 * @returns The next status for the task
 */
export function determineNextStage(
  db: DatabaseSync,
  task: Task,
  selfReview: boolean,
  reviewRun: boolean,
  workflow: ProjectWorkflow | null,
): Task["status"] {
  const runStartedAt = task.started_at ?? 0;
  const activeStages = resolveActiveStages(db, workflow);

  // QA run completed — check QA verdict
  if (task.status === "qa_testing") {
    const logs = db
      .prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'assistant' AND created_at >= ? ORDER BY id DESC LIMIT 50",
      )
      .all(task.id, runStartedAt) as Array<{ message: string }>;

    const qaFailed = logs.some((l) => l.message.includes("[QA:FAIL"));
    if (qaFailed) {
      recordFailedStage(db, task.id, "qa_testing");
      return "inbox";
    }
    clearFailedStage(db, task.id);
    return nextStage("qa_testing", activeStages);
  }

  // test_generation completed — move to next stage
  if (task.status === "test_generation") {
    clearFailedStage(db, task.id);
    return nextStage("test_generation", activeStages);
  }

  // pre_deploy completed — move to done
  if (task.status === "pre_deploy") {
    const logs = db
      .prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'assistant' AND created_at >= ? ORDER BY id DESC LIMIT 50",
      )
      .all(task.id, runStartedAt) as Array<{ message: string }>;

    const failed = logs.some((l) => l.message.includes("[PRE_DEPLOY:FAIL"));
    if (failed) {
      recordFailedStage(db, task.id, "pre_deploy");
      return "inbox";
    }
    clearFailedStage(db, task.id);
    return "done";
  }

  // Review run completed (pr_review)
  if (reviewRun) {
    const logs = db
      .prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'assistant' AND created_at >= ? ORDER BY id DESC LIMIT 50",
      )
      .all(task.id, runStartedAt) as Array<{ message: string }>;

    const needsChanges = logs.some((l) =>
      l.message.includes("[REVIEW:NEEDS_CHANGES]"),
    );
    if (needsChanges) {
      recordFailedStage(db, task.id, "pr_review");
      return "inbox";
    }

    const passed = logs.some((l) => l.message.includes("[REVIEW:PASS]"));
    const autoDone = getSetting(db, "auto_done") ?? "true";
    if (autoDone !== "true") {
      if (!passed) return "pr_review";
    }
    clearFailedStage(db, task.id);
    return nextStage("pr_review", activeStages);
  }

  // Self-review completed
  if (selfReview) {
    const logs = db
      .prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'assistant' AND created_at >= ? ORDER BY id DESC LIMIT 50",
      )
      .all(task.id, runStartedAt) as Array<{ message: string }>;

    const passed = logs.some((l) =>
      l.message.includes("[SELF_REVIEW:PASS]"),
    );
    if (passed) return nextStage("pr_review", activeStages);
    return nextStage("in_progress", activeStages);
  }

  // Implementation completed — check if resuming from a failed stage
  const failedStage = findLastFailedStage(db, task.id);
  if (failedStage && activeStages.includes(failedStage)) {
    // Resume from the previously failed stage instead of starting over
    return failedStage;
  }

  return nextStage("in_progress", activeStages);
}
