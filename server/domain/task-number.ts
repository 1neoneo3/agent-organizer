import type { DatabaseSync } from "node:sqlite";

/**
 * SQL filter that keeps only rows whose task_number is a valid
 * sequential `#<decimal>` value. The round-trip through INTEGER
 * rejects hex fragments (`#40b0c5` → CAST gives 40, TEXT gives '40'
 * ≠ '40b0c5') and leading-zero UUID prefixes (`#082098` → CAST gives
 * 82098, TEXT gives '82098' ≠ '082098').
 */
const VALID_TASK_NUMBER_SQL =
  "task_number LIKE '#%' AND LENGTH(task_number) > 1 AND CAST(CAST(SUBSTR(task_number, 2) AS INTEGER) AS TEXT) = SUBSTR(task_number, 2)";

/**
 * Return true when `value` is a well-formed sequential task number:
 * `#` followed by one or more ASCII digits that survive a
 * parseInt round-trip (no leading zeros, no hex letters).
 */
export function isValidSequentialTaskNumber(value: string): boolean {
  if (!value.startsWith("#") || value.length < 2) return false;
  const numeric = value.slice(1);
  if (!/^[0-9]+$/.test(numeric)) return false;
  return String(parseInt(numeric, 10)) === numeric;
}

/**
 * Compute the next sequential `#<N>` task number, ignoring rows
 * whose task_number contains hex letters, leading zeros, or any
 * other non-canonical form.
 */
export function nextTaskNumber(db: DatabaseSync): string {
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(task_number, 2) AS INTEGER)) AS max_num FROM tasks WHERE ${VALID_TASK_NUMBER_SQL}`,
    )
    .get() as { max_num: number | null } | undefined;
  return `#${(row?.max_num ?? 0) + 1}`;
}

const UUID_RE =
  /^Task [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return true when a title looks like a machine-generated UUID
 * placeholder (e.g. `Task 40b0c57e-1234-...`).
 */
export function isUuidLikeTitle(title: string): boolean {
  return UUID_RE.test(title);
}

/**
 * Existing corrupted rows have already lost the original human title, so the
 * best remediation we can do at startup is replace the UUID placeholder with a
 * stable, readable fallback tied to the repaired task number.
 */
export function buildRecoveredTaskTitle(
  taskNumber: string | null,
  taskId: string,
): string {
  return taskNumber
    ? `Recovered task ${taskNumber}`
    : `Recovered task ${taskId.slice(0, 8)}`;
}

export { VALID_TASK_NUMBER_SQL };
