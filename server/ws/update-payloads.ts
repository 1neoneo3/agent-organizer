import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../types/runtime.js";
import { deriveTaskFields, type TaskDerivedFields } from "../domain/task-derived-fields.js";
import { inferControllerParentForTask } from "../domain/controller-parent.js";
import { getLatestHumanReviewAutoStatus } from "../domain/human-review-auto.js";

export type TaskUpdateKey = Exclude<keyof Task, "id">;

export function pickTaskUpdate(
  task: Pick<Task, "id"> & Partial<Task>,
  keys: readonly TaskUpdateKey[],
): Partial<Task> & { id: string } {
  const payload: Partial<Task> & { id: string } = { id: task.id };
  const target = payload as Record<string, unknown>;

  for (const key of keys) {
    const value = task[key];
    if (Object.prototype.hasOwnProperty.call(task, key) && value !== undefined) {
      target[key] = value;
    }
  }

  return payload;
}

/**
 * Columns shipped over WebSocket `task_update` broadcasts and over the
 * `GET /tasks` summary list. Excludes heavy fields (description, result,
 * refinement_plan, interactive_prompt_data, repository_urls, pr_urls,
 * merged_pr_urls) — those are only fetched on demand via `GET /tasks/:id`.
 * `planned_files` is intentionally included because the kanban computes
 * live file-conflict blockers from the visible task set.
 */
export const TASK_SUMMARY_KEYS: readonly TaskUpdateKey[] = [
  "title",
  "assigned_agent_id",
  "project_path",
  "status",
  "priority",
  "task_size",
  "task_number",
  "parent_task_id",
  "parent_task_number",
  "split_index",
  "split_total",
  "depends_on",
  "planned_files",
  "controller_stage",
  "refinement_completed_at",
  "refinement_revision_requested_at",
  "refinement_revision_completed_at",
  "review_count",
  "directive_id",
  "pr_url",
  "external_source",
  "external_id",
  "review_branch",
  "review_commit_sha",
  "review_sync_status",
  "review_sync_error",
  "repository_url",
  "settings_overrides",
  "started_at",
  "completed_at",
  "last_heartbeat_at",
  "auto_respawn_count",
  "human_review_auto_status",
  "created_at",
  "updated_at",
] as const;

/**
 * Build a `task_update` payload keyed to TASK_SUMMARY_KEYS plus the three
 * derived fields (parent_task_number, child_task_numbers,
 * has_refinement_plan). The derived fields are computed from the task's
 * `description`, `result`, and `refinement_plan` so the client can update
 * the kanban display without a follow-up `GET /tasks/:id`.
 *
 * Heavy raw columns (description, result, refinement_plan, etc.) are
 * intentionally NOT included so the WS payload stays bounded even when
 * a task carries a large refinement plan.
 */
export function buildTaskSummaryUpdate(
  task: Pick<Task, "id"> & Partial<Task>,
  options: { db?: DatabaseSync } = {},
): Partial<Task> & { id: string } & TaskDerivedFields {
  const payload = pickTaskUpdate(task, TASK_SUMMARY_KEYS) as
    Partial<Task> & { id: string } & Partial<TaskDerivedFields>;
  const controllerParent = options.db
    ? inferControllerParentForTask(options.db, {
        controller_stage: task.controller_stage ?? null,
        directive_id: task.directive_id ?? null,
        parent_task_id: task.parent_task_id ?? null,
        parent_task_number: task.parent_task_number ?? null,
      })
    : null;
  const derived = deriveTaskFields({
    parent_task_id: task.parent_task_id ?? controllerParent?.id ?? null,
    parent_task_number: task.parent_task_number ?? controllerParent?.task_number ?? null,
    parent_task_title: task.parent_task_title ?? controllerParent?.title ?? null,
    split_index: task.split_index ?? null,
    split_total: task.split_total ?? null,
    description: task.description ?? null,
    result: task.result ?? null,
    refinement_plan: task.refinement_plan ?? null,
  });
  payload.parent_task_id = derived.parent_task_id;
  payload.parent_task_number = derived.parent_task_number;
  payload.parent_task_title = derived.parent_task_title;
  payload.split_index = derived.split_index;
  payload.split_total = derived.split_total;
  payload.child_task_numbers = derived.child_task_numbers;
  payload.has_refinement_plan = derived.has_refinement_plan;
  payload.human_review_auto_status = task.human_review_auto_status ??
    (options.db ? getLatestHumanReviewAutoStatus(options.db, task.id) : null);
  return payload as Partial<Task> & { id: string } & TaskDerivedFields;
}
