/**
 * Domain: Task status
 *
 * Single source of truth for task statuses. All layers (DB schema, HTTP
 * validation, TypeScript types, workflow pipeline) MUST derive their
 * representation from the constants defined here instead of re-listing
 * the status strings.
 *
 * This module is intentionally dependency-free: it must not import from
 * node:sqlite, express, zod, or any infrastructure layer. That keeps the
 * rules testable and reusable.
 */

/**
 * All valid task statuses, in no particular order.
 *
 * Adding or removing a status? This is the ONLY place to edit.
 */
export const TASK_STATUSES = [
  "inbox",
  "in_progress",
  "self_review",
  "test_generation",
  "qa_testing",
  "pr_review",
  "human_review",
  "pre_deploy",
  "done",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Statuses that represent a completed lifecycle. When a task enters one of
 * these, `completed_at` is stamped and the task is no longer eligible for
 * dispatch / auto-stage promotion.
 */
export const TERMINAL_STATUSES = ["done", "cancelled"] as const satisfies readonly TaskStatus[];

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * Auto-stages: statuses driven by background processes (auto-reviewer,
 * auto-qa, auto-test-gen, auto-pre-deploy). Tasks in these statuses are
 * watched by the orphan recovery job and must emit heartbeats.
 */
export const AUTO_STAGES = [
  "pr_review",
  "qa_testing",
  "test_generation",
  "pre_deploy",
] as const satisfies readonly TaskStatus[];

export type AutoStage = (typeof AUTO_STAGES)[number];

/**
 * Workflow pipeline stages in the order they must be completed. Does NOT
 * include `inbox` (initial state) or `cancelled` (terminal escape hatch).
 *
 * `self_review` is also excluded: it is a transient marker used by
 * process-manager and not a pipeline stage that `validateStatusTransition`
 * should order.
 */
export const WORKFLOW_STAGES = [
  "in_progress",
  "test_generation",
  "qa_testing",
  "pr_review",
  "human_review",
  "pre_deploy",
  "done",
] as const satisfies readonly TaskStatus[];

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

/**
 * Build a SQL `CHECK(column IN ('a','b',...))` clause from a readonly list
 * of statuses. Used by the schema module to keep the DB constraint in sync
 * with the TypeScript constant.
 */
export function buildSqlCheckIn(
  column: string,
  values: readonly string[],
): string {
  const quoted = values.map((v) => `'${v}'`).join(",");
  return `CHECK(${column} IN (${quoted}))`;
}
