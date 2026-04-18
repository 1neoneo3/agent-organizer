import type { DatabaseSync } from "node:sqlite";
import { intersectFilePaths, parsePlannedFiles } from "./planned-files.js";

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

/**
 * File-level conflict detected between two tasks whose static
 * planned_files overlap. Surfaces the other task's identity and the
 * specific paths that overlap, so both the log message and the API
 * response can explain exactly which files are contested.
 */
export interface FileConflict {
  task_number: string;
  status: string; // stage of the conflicting task (in_progress, refinement, …)
  overlapping_files: string[];
}

/**
 * Stages at which a task is considered "actively editing files" and
 * therefore a file-conflict blocker for a downstream task. Refinement
 * is included because the refinement-as-pr mode writes the plan to a
 * branch, and because even a read-only refinement has a planned_files
 * list that may be invalidated if another task lands first.
 *
 * Terminal states (`done`, `cancelled`) are NOT in this list:
 *  - `done` is the contract for "safe to start downstream work"
 *  - `cancelled` tasks can still leave orphaned edits, but the
 *    depends_on / task_number gate already blocks on `cancelled`, so
 *    file-conflict checking there would be redundant.
 */
const ACTIVE_EDITING_STAGES: readonly string[] = [
  "refinement",
  "in_progress",
  "self_review",
  "test_generation",
  "ci_check",
  "qa_testing",
  "pr_review",
  "human_review",
];

/**
 * Return every active task whose planned_files overlap with the given
 * task's planned_files. An empty result means the task is free to
 * advance as far as static file analysis can tell.
 *
 *  - Tasks with no planned_files on either side are skipped: a NULL
 *    list means "the static analyzer does not know what I will touch",
 *    so claiming a conflict would be unsound.
 *  - The task itself is never reported as conflicting with itself.
 *  - Only tasks currently in `ACTIVE_EDITING_STAGES` are considered.
 */
export function getFileConflicts(
  db: DatabaseSync,
  task: { id: string; planned_files: string | null },
): FileConflict[] {
  const mine = parsePlannedFiles(task.planned_files);
  if (mine.length === 0) return [];

  const placeholders = ACTIVE_EDITING_STAGES.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, task_number, status, planned_files
       FROM tasks
       WHERE id != ?
         AND status IN (${placeholders})
         AND planned_files IS NOT NULL
         AND planned_files <> ''`,
    )
    .all(task.id, ...ACTIVE_EDITING_STAGES) as Array<{
      id: string;
      task_number: string | null;
      status: string;
      planned_files: string | null;
    }>;

  const conflicts: FileConflict[] = [];
  for (const row of rows) {
    const theirs = parsePlannedFiles(row.planned_files);
    if (theirs.length === 0) continue;
    const overlap = intersectFilePaths(mine, theirs);
    if (overlap.length === 0) continue;
    conflicts.push({
      task_number: row.task_number ?? row.id,
      status: row.status,
      overlapping_files: overlap,
    });
  }
  return conflicts;
}

/**
 * Format a file-conflict list for use in log messages and API error
 * bodies. Example output:
 *   `#12 (in_progress) → src/auth.ts, src/middleware.ts`
 */
export function formatFileConflicts(conflicts: FileConflict[]): string {
  return conflicts
    .map((c) => `${c.task_number} (${c.status}) → ${c.overlapping_files.join(", ")}`)
    .join("; ");
}

/**
 * Combined gate used by every "→in_progress" entry point. Returns
 * structured blockers when either the declared `depends_on` chain or
 * the static planned_files intersection says the task must wait.
 */
export interface TaskBlockers {
  dependencies: BlockingDependency[];
  fileConflicts: FileConflict[];
}

/**
 * Convenience: true when either dependency or file-conflict blockers
 * exist. Every dispatch-gate site calls this before advancing a task.
 */
export function isBlocked(blockers: TaskBlockers): boolean {
  return blockers.dependencies.length > 0 || blockers.fileConflicts.length > 0;
}

/**
 * Fetch all blockers for a task in one call — checks declared
 * dependencies and static planned_files overlap. Callers pattern-
 * match on the result with `isBlocked` + the detail arrays.
 */
export function collectAllBlockers(
  db: DatabaseSync,
  task: { id: string; depends_on: string | null; planned_files: string | null },
): TaskBlockers {
  return {
    dependencies: getBlockingDependencies(db, task),
    fileConflicts: getFileConflicts(db, task),
  };
}

/**
 * Render a combined blocker description for log messages / API
 * responses. Includes both categories if either is non-empty.
 */
export function formatAllBlockers(blockers: TaskBlockers): string {
  const parts: string[] = [];
  if (blockers.dependencies.length > 0) {
    parts.push(`depends_on: ${formatBlockingDependencies(blockers.dependencies)}`);
  }
  if (blockers.fileConflicts.length > 0) {
    parts.push(`file conflicts: ${formatFileConflicts(blockers.fileConflicts)}`);
  }
  return parts.join("; ");
}
