/**
 * Domain: Review loop rules
 *
 * Rules that govern the automatic code-review loop. The goal is to keep
 * the "how many reviews is too many" and "when do we escalate to a human"
 * decisions in exactly one place so that auto-reviewer and auto-dispatch
 * cannot drift apart.
 *
 * This module only depends on the DatabaseSync handle for settings lookup
 * and the pure Task type. No WebSocket, no process spawning, no HTTP.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../types/runtime.js";

/**
 * Hard-coded fallback used when the `review_count` setting row is missing.
 * This matches the legacy default that was duplicated in auto-reviewer.ts
 * (`?? "3"`) and auto-dispatch.ts (`?? "3"`).
 */
export const DEFAULT_MAX_REVIEW_COUNT = 3;

/**
 * Resolve the configured cap on automatic review iterations.
 *
 * The setting is stored as a string in the `settings` table under the
 * key `review_count`. A missing or unparseable value falls back to
 * `DEFAULT_MAX_REVIEW_COUNT`.
 */
export function getMaxReviewCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get("review_count") as { value: string } | undefined;

  if (!row?.value) return DEFAULT_MAX_REVIEW_COUNT;

  const parsed = Number(row.value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_REVIEW_COUNT;

  return parsed;
}

/**
 * Should a task in `pr_review` be escalated to `human_review` because the
 * automatic review loop has been exhausted?
 *
 * Returns `true` when `review_count` has reached or exceeded the cap.
 * Auto-reviewer uses this to stop spawning new review runs; auto-dispatch
 * uses it to avoid picking up a task that has been returned to inbox but
 * is already past the cap.
 */
export function hasExhaustedReviewBudget(
  task: Pick<Task, "review_count">,
  maxReviewCount: number,
): boolean {
  return task.review_count >= maxReviewCount;
}
