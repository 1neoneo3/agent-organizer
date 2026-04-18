import type { DatabaseSync } from "node:sqlite";

/**
 * Task dependency resolution.
 *
 * `tasks.depends_on` is a JSON array of `task_number` strings (e.g.
 * `["#12", "#13"]`). A task is considered blocked by any dependency
 * whose current status is not "done" — matching the semantics of the
 * existing auto-dispatcher: until a prerequisite actually finishes,
 * downstream tasks must not touch overlapping files and must not
 * advance toward `in_progress`.
 *
 * The helpers here centralize the check so every entry point that can
 * move a task into `in_progress` (manual Run, Resume, refinement
 * approve, auto-dispatch, …) enforces the same rule. Callers that used
 * to inline the lookup against `status = 'done'` should be migrated to
 * `getBlockingDependencies` below.
 */

export interface BlockingDependency {
  task_number: string;
  status: string; // current status of the dependency (e.g. "in_progress")
}

/**
 * Parse `tasks.depends_on` into a string array. Silently yields an
 * empty array for null, malformed JSON, or non-array payloads — the
 * task is then treated as having no declared dependencies.
 */
export function parseDependsOn(rawDependsOn: string | null): string[] {
  if (!rawDependsOn) return [];
  try {
    const parsed = JSON.parse(rawDependsOn);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Return dependencies that are NOT yet in the terminal `done` state.
 * An empty array means the task is free to advance.
 *
 * When a dependency task_number is unknown (not in DB), it is treated
 * as blocking — this prevents silently skipping a missing prerequisite
 * that might still be created by an upstream process.
 */
export function getBlockingDependencies(
  db: DatabaseSync,
  task: { depends_on: string | null },
): BlockingDependency[] {
  const deps = parseDependsOn(task.depends_on);
  if (deps.length === 0) return [];

  const blocking: BlockingDependency[] = [];
  const selectStmt = db.prepare(
    "SELECT task_number, status FROM tasks WHERE task_number = ? LIMIT 1",
  );
  for (const depNumber of deps) {
    const row = selectStmt.get(depNumber) as
      | { task_number: string; status: string }
      | undefined;
    if (!row) {
      blocking.push({ task_number: depNumber, status: "unknown" });
      continue;
    }
    if (row.status !== "done") {
      blocking.push({ task_number: row.task_number, status: row.status });
    }
  }
  return blocking;
}

/**
 * Convenience: `true` when the task has at least one unfinished
 * dependency. Equivalent to `getBlockingDependencies(...).length > 0`
 * but avoids constructing the detail list at call sites that only need
 * a boolean gate.
 */
export function hasBlockingDependencies(
  db: DatabaseSync,
  task: { depends_on: string | null },
): boolean {
  return getBlockingDependencies(db, task).length > 0;
}

/**
 * Format a blocker list for use in log messages and API error bodies.
 * Example output: `#12 (in_progress), #13 (refinement)`.
 */
export function formatBlockingDependencies(blockers: BlockingDependency[]): string {
  return blockers.map((b) => `${b.task_number} (${b.status})`).join(", ");
}
