/**
 * Derived fields appended to TaskSummary so the kanban can display
 * parent/child relationships and "has plan" state without shipping the
 * heavy `description`, `result`, or `refinement_plan` columns to the
 * client.
 *
 * Sources:
 *   - parent_task_number  ←  description.match(/^Step \d+ of (#\d+)/)
 *   - child_task_numbers  ←  result.match(/^Split into (#[\d, #]+)/)
 *   - has_refinement_plan ←  refinement_plan IS NOT NULL AND != ''
 *
 * Centralized here so the GET /tasks SQL handler and the WebSocket
 * `task_update` broadcast path use the same regex / boolean rules.
 */

const PARENT_REF_REGEX = /^Step \d+ of (#\d+)/;
const CHILD_REF_REGEX = /^Split into (#[\d, #]+)/;

export function deriveParentTaskNumber(
  description: string | null | undefined,
): string | null {
  if (!description) return null;
  return description.match(PARENT_REF_REGEX)?.[1] ?? null;
}

export function deriveChildTaskNumbers(
  result: string | null | undefined,
): string[] | null {
  if (!result) return null;
  const m = result.match(CHILD_REF_REGEX);
  if (!m) return null;
  const items = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

export function deriveHasRefinementPlan(
  refinementPlan: string | null | undefined,
): boolean {
  return refinementPlan != null && refinementPlan !== "";
}

export interface TaskDerivedFields {
  parent_task_number: string | null;
  child_task_numbers: string[] | null;
  has_refinement_plan: boolean;
}

/**
 * Compute all three derived fields from a task row (full DB row or a
 * row that contains description/result/refinement_plan). Used by:
 *   - GET /tasks summary handler (loops over rows after SELECT)
 *   - WebSocket task_update broadcast (re-fetches needed columns)
 */
export function deriveTaskFields(row: {
  description: string | null | undefined;
  result: string | null | undefined;
  refinement_plan: string | null | undefined;
}): TaskDerivedFields {
  return {
    parent_task_number: deriveParentTaskNumber(row.description),
    child_task_numbers: deriveChildTaskNumbers(row.result),
    has_refinement_plan: deriveHasRefinementPlan(row.refinement_plan),
  };
}
