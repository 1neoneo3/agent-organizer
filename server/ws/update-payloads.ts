import type { Task } from "../types/runtime.js";
import { deriveTaskFields, type TaskDerivedFields } from "../domain/task-derived-fields.js";

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
 * refinement_plan, planned_files, interactive_prompt_data, repository_urls,
 * pr_urls, merged_pr_urls) — those are only fetched on demand via
 * `GET /tasks/:id`.
 */
export const TASK_SUMMARY_KEYS: readonly TaskUpdateKey[] = [
  "title",
  "assigned_agent_id",
  "project_path",
  "status",
  "priority",
  "task_size",
  "task_number",
  "depends_on",
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
): Partial<Task> & { id: string } & TaskDerivedFields {
  const payload = pickTaskUpdate(task, TASK_SUMMARY_KEYS) as
    Partial<Task> & { id: string } & Partial<TaskDerivedFields>;
  const derived = deriveTaskFields({
    description: task.description ?? null,
    result: task.result ?? null,
    refinement_plan: task.refinement_plan ?? null,
  });
  payload.parent_task_number = derived.parent_task_number;
  payload.child_task_numbers = derived.child_task_numbers;
  payload.has_refinement_plan = derived.has_refinement_plan;
  return payload as Partial<Task> & { id: string } & TaskDerivedFields;
}
