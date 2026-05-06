/**
 * Derived fields appended to TaskSummary so the kanban can display
 * parent/child relationships and "has plan" state without shipping the
 * heavy `description`, `result`, or `refinement_plan` columns to the
 * client.
 *
 * Sources:
 *   - parent_task_number  ←  explicit DB column, fallback split description prefix
 *   - child_task_numbers  ←  result.match(/^Split into (#[\d, #]+)/)
 *   - has_refinement_plan ←  refinement_plan IS NOT NULL AND != ''
 *
 * Centralized here so the GET /tasks SQL handler and the WebSocket
 * `task_update` broadcast path use the same regex / boolean rules.
 */

const TASK_REF = "([#][0-9]+|[A-Z]+[0-9]+)";
const PARENT_REF_REGEXES: ReadonlyArray<{ regex: RegExp; parentIndex: number; stepIndex: number }> = [
  { regex: new RegExp(`^Step\\s+(\\d+)\\s+of\\s+${TASK_REF}`), parentIndex: 2, stepIndex: 1 },
  { regex: new RegExp(`^${TASK_REF}\\s+のステップ\\s+(\\d+)`), parentIndex: 1, stepIndex: 2 },
] as const;
const CHILD_REF_REGEX = /^Split into (#[\d, #]+)/;

export function deriveParentTaskNumber(
  description: string | null | undefined,
): string | null {
  if (!description) return null;
  for (const { regex, parentIndex } of PARENT_REF_REGEXES) {
    const match = description.match(regex);
    if (!match) continue;
    return match[parentIndex] ?? null;
  }
  return null;
}

export function deriveSplitIndex(
  description: string | null | undefined,
): number | null {
  if (!description) return null;
  for (const { regex, stepIndex } of PARENT_REF_REGEXES) {
    const match = description.match(regex);
    if (!match) continue;
    const rawStep = match[stepIndex];
    const step = Number(rawStep);
    return Number.isFinite(step) ? step : null;
  }
  return null;
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
  parent_task_id: string | null;
  parent_task_number: string | null;
  parent_task_title: string | null;
  split_index: number | null;
  split_total: number | null;
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
  parent_task_id?: string | null | undefined;
  parent_task_number?: string | null | undefined;
  parent_task_title?: string | null | undefined;
  split_index?: number | null | undefined;
  split_total?: number | null | undefined;
  description: string | null | undefined;
  result: string | null | undefined;
  refinement_plan: string | null | undefined;
}): TaskDerivedFields {
  return {
    parent_task_id: row.parent_task_id ?? null,
    parent_task_number: row.parent_task_number ?? deriveParentTaskNumber(row.description),
    parent_task_title: row.parent_task_title ?? null,
    split_index: row.split_index ?? deriveSplitIndex(row.description),
    split_total: row.split_total ?? null,
    child_task_numbers: deriveChildTaskNumbers(row.result),
    has_refinement_plan: deriveHasRefinementPlan(row.refinement_plan),
  };
}
