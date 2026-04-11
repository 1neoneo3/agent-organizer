import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../types/runtime.js";
import type { ProjectWorkflow } from "./loader.js";
import { WORKFLOW_STAGES, type WorkflowStage } from "../domain/task-status.js";

export { WORKFLOW_STAGES };
export type { WorkflowStage };

/**
 * Validate whether a manual status transition is allowed.
 *
 * Allowed transitions:
 *  - Any status → "inbox" (reset)
 *  - Any status → "cancelled" (cancel)
 *  - Forward-only within the active pipeline (no skipping stages)
 *  - "inbox" → "in_progress" (start/restart)
 *
 * Returns null if valid, or an error message string if invalid.
 */
export function validateStatusTransition(
  db: DatabaseSync,
  currentStatus: string,
  newStatus: string,
  workflow: ProjectWorkflow | null,
  taskSize?: "small" | "medium" | "large",
): string | null {
  // Always allow reset to inbox or cancel
  if (newStatus === "inbox" || newStatus === "cancelled") return null;

  // Allow inbox → in_progress (start task)
  if (currentStatus === "inbox" && newStatus === "in_progress") return null;

  // Allow cancelled → inbox (reopen)
  if (currentStatus === "cancelled" && newStatus === "inbox") return null;

  const activeStages = resolveActiveStages(db, workflow, taskSize);

  const currentIndex = activeStages.indexOf(currentStatus as WorkflowStage);
  const newIndex = activeStages.indexOf(newStatus as WorkflowStage);

  // If new status is not in the pipeline, reject
  if (newIndex === -1) {
    return `Status "${newStatus}" is not an active stage in the current workflow pipeline.`;
  }

  // If current status is not in the pipeline (e.g. self_review), allow forward transitions
  if (currentIndex === -1) return null;

  // Only allow moving to the immediate next stage (no skipping)
  if (newIndex === currentIndex + 1) return null;

  // Allow staying at the same stage (no-op)
  if (newIndex === currentIndex) return null;

  // Backward transitions are not allowed (use inbox reset instead)
  if (newIndex < currentIndex) {
    return `Cannot move backward from "${currentStatus}" to "${newStatus}". Reset to inbox first.`;
  }

  // Skipping stages is not allowed
  const skippedStages = activeStages.slice(currentIndex + 1, newIndex);
  return `Cannot skip stages. Must pass through: ${skippedStages.join(" → ")} before reaching "${newStatus}".`;
}

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
/**
 * Resolve an on/off decision for an optional workflow stage toggle.
 *
 * Precedence:
 *   1. If `WORKFLOW.md` explicitly set the flag (true / false), respect it.
 *   2. Otherwise, fall back to the global settings key (e.g.
 *      `default_enable_test_generation`). The setting is stored as a
 *      string and anything other than `"true"` is treated as false.
 *   3. If the setting row is missing, default to `false` so existing
 *      installations keep their pre-change behavior.
 *
 * This fail-safe cascade lets operators enable a stage globally
 * without having to add a WORKFLOW.md to every repository, while still
 * allowing per-project opt-outs via the file.
 */
function resolveWorkflowToggle(
  db: DatabaseSync,
  workflowValue: boolean | null | undefined,
  settingKey: string,
): boolean {
  if (workflowValue === true) return true;
  if (workflowValue === false) return false;
  return getSetting(db, settingKey) === "true";
}

export function resolveActiveStages(
  db: DatabaseSync,
  workflow: ProjectWorkflow | null,
  taskSize?: "small" | "medium" | "large",
): WorkflowStage[] {
  const qaMode = getSetting(db, "qa_mode") ?? "disabled";
  const reviewMode = getSetting(db, "review_mode") ?? "pr_only";

  const stages: WorkflowStage[] = ["in_progress"];

  // test_generation: workflow override → settings default → false.
  // Small tasks always skip this stage regardless of the toggle so the
  // pipeline stays short for trivial work.
  const testGenEnabled = resolveWorkflowToggle(
    db,
    workflow?.enableTestGeneration,
    "default_enable_test_generation",
  );
  if (testGenEnabled && taskSize !== "small") {
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

  // human_review: workflow override → settings default → false
  if (resolveWorkflowToggle(db, workflow?.enableHumanReview, "default_enable_human_review")) {
    stages.push("human_review");
  }

  // pre_deploy: workflow override → settings default → false
  if (resolveWorkflowToggle(db, workflow?.enablePreDeploy, "default_enable_pre_deploy")) {
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
  const activeStages = resolveActiveStages(db, workflow, task.task_size);

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
      // Return to in_progress (not inbox) to preserve completed work
      return "in_progress";
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
      // Return to pr_review (not inbox) to preserve completed work
      return "pr_review";
    }
    // Require explicit [PRE_DEPLOY:PASS] tag. Absence of the verdict is
    // treated as failure so that a crashed or forgetful pre-deploy agent
    // never silently marks a task as ready to ship. Loop protection is
    // handled by max pre-deploy iterations in auto-pre-deploy.ts.
    const passed = logs.some((l) => l.message.includes("[PRE_DEPLOY:PASS]"));
    if (!passed) {
      recordFailedStage(db, task.id, "pre_deploy");
      return "pr_review";
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
      // Return to in_progress (not inbox) to preserve completed work
      return "in_progress";
    }

    // Require explicit [REVIEW:PASS] tag. Absence of the verdict is treated
    // as needing rework, so a crashed or forgetful reviewer can never cause
    // an implicit pass-through. Loop protection is handled by review_count
    // max in auto-reviewer.ts (defaults to 3 iterations) — once the cap is
    // hit, auto-review stops and the task stays in pr_review for manual
    // action instead of being silently promoted.
    const passed = logs.some((l) => l.message.includes("[REVIEW:PASS]"));
    if (!passed) {
      recordFailedStage(db, task.id, "pr_review");
      return "in_progress";
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
