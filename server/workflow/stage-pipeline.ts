import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../types/runtime.js";
import type { ProjectWorkflow } from "./loader.js";
import { WORKFLOW_STAGES, type WorkflowStage } from "../domain/task-status.js";
import {
  getLatestCheckResults,
  type CheckResult,
} from "../spawner/auto-checks.js";
import {
  hasParallelTestCompletion,
  isParallelImplTestEnabled,
} from "./parallel-impl.js";

export { WORKFLOW_STAGES };
export type { WorkflowStage };

/**
 * Verdict derived from auto-check results for a task.
 *
 *   - `none`   — no results recorded (feature disabled, no specs, or
 *                the server restarted since the last run). The pipeline
 *                falls back to review-only gating.
 *   - `pass`   — every check recorded ok=true.
 *   - `fail`   — at least one check failed. The pipeline forces rework
 *                regardless of what the LLM reviewer said, because a
 *                broken type check or failing test is a hard block.
 */
export type CheckVerdict = "none" | "pass" | "fail";

/**
 * Compute the aggregated verdict from a set of {@link CheckResult}s.
 * Exported for unit testing; production code should call
 * {@link resolveCheckVerdictForTask} which fetches the latest results
 * from the auto-checks in-memory store.
 */
export function aggregateCheckResults(
  results: CheckResult[] | undefined | null,
): CheckVerdict {
  if (!results || results.length === 0) return "none";
  return results.some((r) => !r.ok) ? "fail" : "pass";
}

/**
 * Resolve the check verdict for a task by reading the most recent
 * completed results from the auto-checks module. Wraps
 * {@link aggregateCheckResults} so the pipeline can decide without
 * depending on the auto-checks internal map shape.
 */
export function resolveCheckVerdictForTask(taskId: string): CheckVerdict {
  return aggregateCheckResults(getLatestCheckResults(taskId));
}

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

  // Allow inbox → first active stage (refinement or in_progress)
  if (currentStatus === "inbox" && (newStatus === "in_progress" || newStatus === "refinement")) return null;

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
 * Precedence (Settings is SSOT):
 *   1. If the global settings key exists (e.g.
 *      `default_enable_human_review`), its value wins unconditionally.
 *      The settings UI is the single source of truth for stage
 *      enablement.
 *   2. If the setting row is missing (not "true" or "false", but
 *      literally absent from the DB), fall back to `WORKFLOW.md`.
 *   3. If neither source has an opinion, default to `false`.
 *
 * This ensures the settings UI always reflects reality. WORKFLOW.md
 * serves as a per-project hint only when the operator has not yet
 * configured the global setting.
 */
function resolveWorkflowToggle(
  db: DatabaseSync,
  workflowValue: boolean | null | undefined,
  settingKey: string,
): boolean {
  const settingValue = getSetting(db, settingKey);
  // Settings key exists → it is the SSOT.
  if (settingValue !== undefined) return settingValue === "true";
  // Settings key absent → fall back to WORKFLOW.md.
  if (workflowValue === true) return true;
  if (workflowValue === false) return false;
  return false;
}

export function resolveActiveStages(
  db: DatabaseSync,
  workflow: ProjectWorkflow | null,
  taskSize?: "small" | "medium" | "large",
  /**
   * AO Phase 3: optional task id. When provided, `resolveActiveStages`
   * additionally checks whether the parallel impl/test mode has already
   * produced a `[PARALLEL_TEST:DONE]` marker for this task. If it has,
   * the serial `test_generation` stage is dropped — running it would be
   * a redundant second round of test generation after the parallel
   * tester already finished. Callers that don't have a task id (e.g.
   * `validateStatusTransition` at task creation time) can safely omit
   * this argument and will get the historical behavior.
   */
  taskId?: string,
): WorkflowStage[] {
  const qaMode = getSetting(db, "qa_mode") ?? "disabled";
  const reviewMode = getSetting(db, "review_mode") ?? "pr_only";

  const stages: WorkflowStage[] = [];

  // refinement: optional planning/requirements gate before implementation
  if (resolveWorkflowToggle(db, workflow?.enableRefinement, "default_enable_refinement")) {
    stages.push("refinement");
  }

  stages.push("in_progress");

  // test_generation: workflow override → settings default → false.
  // Small tasks always skip this stage regardless of the toggle so the
  // pipeline stays short for trivial work. When the parallel impl/test
  // mode has already finished for this task (DONE marker present),
  // drop the serial stage entirely to avoid duplicated work.
  const testGenEnabled = resolveWorkflowToggle(
    db,
    workflow?.enableTestGeneration,
    "default_enable_test_generation",
  );
  const parallelAlreadyRan =
    taskId !== undefined &&
    isParallelImplTestEnabled(db) &&
    hasParallelTestCompletion(db, taskId);
  if (testGenEnabled && taskSize !== "small" && !parallelAlreadyRan) {
    stages.push("test_generation");
  }

  // ci_check: verify CI/CD infrastructure exists and is passing.
  // Positioned after implementation / test generation but before QA and
  // review so that CI gaps are caught early.
  if (resolveWorkflowToggle(db, workflow?.enableCiCheck, "default_enable_ci_check")) {
    stages.push("ci_check");
  }

  // qa_testing: controlled by settings (qa_mode)
  if (qaMode === "enabled") {
    stages.push("qa_testing");
  }

  // pr_review: controlled by settings (review_mode)
  if (reviewMode !== "none") {
    stages.push("pr_review");
  }

  // human_review: settings SSOT → WORKFLOW.md fallback → false
  if (resolveWorkflowToggle(db, workflow?.enableHumanReview, "default_enable_human_review")) {
    stages.push("human_review");
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
  // Pass task.id so parallel-mode completion drops the serial
  // test_generation stage for this task only.
  const activeStages = resolveActiveStages(db, workflow, task.task_size, task.id);

  // Refinement completed — check if auto-approve or wait for human
  if (task.status === "refinement") {
    const autoApprove = getSetting(db, "refinement_auto_approve") === "true";
    if (autoApprove) {
      clearFailedStage(db, task.id);
      return nextStage("refinement", activeStages);
    }
    // Stay in refinement waiting for human approval via approve/reject API
    return "refinement";
  }

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

  // ci_check completed — verify CI/CD infrastructure is in place
  if (task.status === "ci_check") {
    const logs = db
      .prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'assistant' AND created_at >= ? ORDER BY id DESC LIMIT 50",
      )
      .all(task.id, runStartedAt) as Array<{ message: string }>;

    const failed = logs.some((l) => l.message.includes("[CI_CHECK:FAIL"));
    if (failed) {
      recordFailedStage(db, task.id, "ci_check");
      // Return to in_progress — CI gaps need implementation work, not review
      return "in_progress";
    }
    // Require explicit [CI_CHECK:PASS] tag. Absence of the verdict is
    // treated as failure so that a crashed or forgetful ci-check agent
    // never silently advances the task.
    const passed = logs.some((l) => l.message.includes("[CI_CHECK:PASS]"));
    if (!passed) {
      recordFailedStage(db, task.id, "ci_check");
      return "in_progress";
    }
    clearFailedStage(db, task.id);
    return nextStage("ci_check", activeStages);
  }

  // Review run completed (pr_review)
  //
  // Verdict format (role-tagged, preferred):
  //   [REVIEW:code:PASS]  /  [REVIEW:code:NEEDS_CHANGES:<reason>]
  //   [REVIEW:security:PASS]  /  [REVIEW:security:NEEDS_CHANGES:<reason>]
  //
  // Legacy format (backward compat, treated as "code" role):
  //   [REVIEW:PASS]  /  [REVIEW:NEEDS_CHANGES:<reason>]
  //
  // The expected roles for this run are recorded in a [REVIEWER_PANEL:…]
  // system log entry. If no panel marker exists (legacy single-reviewer
  // or manual trigger), we fall back to requiring any PASS/NEEDS_CHANGES
  // from the combined log set.
  if (reviewRun) {
    // Auto-checks gate (Phase 1): runs in parallel with the LLM
    // reviewer(s). A single failing automated check forces rework
    // regardless of what the reviewer concluded — a broken tsc / lint
    // / test is a hard block that no amount of LLM "looks good to me"
    // should paper over. This gate fires BEFORE review verdict
    // aggregation so a check failure short-circuits the pipeline even
    // if the reviewer panel unanimously passed.
    const checkVerdict = resolveCheckVerdictForTask(task.id);
    if (checkVerdict === "fail") {
      recordFailedStage(db, task.id, "pr_review");
      return "in_progress";
    }

    // Role-based review verdict aggregation (Phase 2): reads the
    // [REVIEWER_PANEL:…] marker to learn which roles were expected,
    // then scans role-tagged and legacy verdict tags in assistant
    // logs. Requires every expected role to PASS for advancement.
    const { needsChanges, allPassed } = aggregateReviewVerdicts(db, task.id, runStartedAt);

    if (needsChanges) {
      recordFailedStage(db, task.id, "pr_review");
      return "in_progress";
    }

    if (!allPassed) {
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

// --------------- Review verdict aggregation ---------------

/**
 * Regex patterns for role-tagged and legacy review verdict tags.
 *
 * Role-tagged (preferred):
 *   [REVIEW:code:PASS]
 *   [REVIEW:security:NEEDS_CHANGES:<reason>]
 *
 * Legacy (backward compat):
 *   [REVIEW:PASS]
 *   [REVIEW:NEEDS_CHANGES:<reason>]
 */
const ROLE_VERDICT_PASS = /\[REVIEW:(\w+):PASS\]/;
const ROLE_VERDICT_NEEDS_CHANGES = /\[REVIEW:(\w+):NEEDS_CHANGES/;
const LEGACY_VERDICT_PASS = /\[REVIEW:PASS\]/;
const LEGACY_VERDICT_NEEDS_CHANGES = /\[REVIEW:NEEDS_CHANGES/;
const PANEL_MARKER = /\[REVIEWER_PANEL:([^\]]+)\]/;

export interface ReviewAggregation {
  /** True when any reviewer (any role) emitted NEEDS_CHANGES. */
  needsChanges: boolean;
  /** True when every expected role has a PASS verdict. */
  allPassed: boolean;
}

/**
 * Aggregate review verdicts from task_logs for a single review run.
 *
 * 1. Read the `[REVIEWER_PANEL:code,security]` system log to discover
 *    which roles were expected in this run.
 * 2. Scan assistant logs for role-tagged verdicts.
 * 3. Legacy (untagged) verdicts count as role="code".
 * 4. Any NEEDS_CHANGES from any role → `needsChanges = true`.
 * 5. `allPassed = true` only when every expected role has at least one
 *    PASS verdict and no NEEDS_CHANGES.
 */
export function aggregateReviewVerdicts(
  db: DatabaseSync,
  taskId: string,
  runStartedAt: number,
): ReviewAggregation {
  // 1. Find the expected roles from the panel marker in system logs
  const systemLogs = db
    .prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND created_at >= ? ORDER BY id DESC LIMIT 50",
    )
    .all(taskId, runStartedAt) as Array<{ message: string }>;

  let expectedRoles: Set<string> | null = null;
  for (const log of systemLogs) {
    const match = log.message.match(PANEL_MARKER);
    if (match) {
      expectedRoles = new Set(match[1].split(",").map((r) => r.trim()));
      break;
    }
  }

  // 2. Scan assistant logs for verdicts
  const assistantLogs = db
    .prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'assistant' AND created_at >= ? ORDER BY id DESC LIMIT 100",
    )
    .all(taskId, runStartedAt) as Array<{ message: string }>;

  const passedRoles = new Set<string>();
  let anyNeedsChanges = false;

  for (const log of assistantLogs) {
    const msg = log.message;

    // Role-tagged NEEDS_CHANGES
    const ncMatch = msg.match(ROLE_VERDICT_NEEDS_CHANGES);
    if (ncMatch) {
      anyNeedsChanges = true;
    }

    // Legacy NEEDS_CHANGES (no role tag → "code")
    if (!ncMatch && LEGACY_VERDICT_NEEDS_CHANGES.test(msg)) {
      anyNeedsChanges = true;
    }

    // Role-tagged PASS
    const passMatch = msg.match(ROLE_VERDICT_PASS);
    if (passMatch) {
      passedRoles.add(passMatch[1]);
    }

    // Legacy PASS → counts as "code"
    if (!passMatch && LEGACY_VERDICT_PASS.test(msg)) {
      passedRoles.add("code");
    }
  }

  // 3. Determine allPassed
  if (anyNeedsChanges) {
    return { needsChanges: true, allPassed: false };
  }

  if (!expectedRoles) {
    // No panel marker → legacy single-reviewer: require at least one PASS
    return { needsChanges: false, allPassed: passedRoles.size > 0 };
  }

  // Every expected role must have a PASS
  const allPassed = [...expectedRoles].every((role) => passedRoles.has(role));
  return { needsChanges: false, allPassed };
}
