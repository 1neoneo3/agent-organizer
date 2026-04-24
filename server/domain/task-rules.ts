/**
 * Domain: Task lifecycle rules
 *
 * Small, pure helpers for reasoning about a task's lifecycle state.
 * These rules are consumed by HTTP handlers, background workers, and
 * lifecycle jobs so that the "which statuses are terminal" / "when do
 * we stamp completed_at" decisions are not re-derived at each call site.
 *
 * Intentionally free of DB, HTTP, and WebSocket dependencies.
 */

import {
  AUTO_STAGES,
  TERMINAL_STATUSES,
  type AutoStage,
  type TaskStatus,
  type TerminalStatus,
} from "./task-status.js";

/**
 * Is the given status a terminal lifecycle state (`done` or `cancelled`)?
 *
 * Used to decide whether `completed_at` should be stamped on the task row
 * and whether the task should be excluded from dispatch / auto-stage
 * promotion.
 */
export function isTerminalStatus(status: TaskStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);
}

/**
 * Is the given status an auto-stage driven by a background process?
 *
 * Auto-stages require heartbeats and are subject to orphan recovery if a
 * task stalls in one of them without a live process.
 */
export function isAutoStage(status: TaskStatus): status is AutoStage {
  return (AUTO_STAGES as readonly TaskStatus[]).includes(status);
}

/**
 * When a task transitions to a new status, should the handler stamp
 * `completed_at` on the row?
 *
 * Rule: only terminal statuses stamp `completed_at`. Transient statuses
 * (including `human_review`) do not.
 */
export function shouldStampCompletedAt(newStatus: TaskStatus): boolean {
  return isTerminalStatus(newStatus);
}
