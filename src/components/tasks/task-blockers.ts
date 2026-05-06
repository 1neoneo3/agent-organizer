import type { TaskSummary } from "../../types/index.js";

const ACTIVE_EDITING_STAGES: ReadonlySet<TaskSummary["status"]> = new Set([
  "refinement",
  "in_progress",
  "test_generation",
  "qa_testing",
  "pr_review",
  "human_review",
]);

export interface TaskBlockerRef {
  kind: "dependency" | "file_conflict";
  taskId?: string;
  taskNumber: string;
  status: TaskSummary["status"] | "unknown";
  overlappingFiles?: string[];
}

export interface TaskCardBlockers {
  dependencies: TaskBlockerRef[];
  fileConflicts: TaskBlockerRef[];
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}

function shouldApplyFileConflictGate(task: TaskSummary): boolean {
  return task.controller_stage == null || task.controller_stage === "implement";
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
  if (left.length === 0 || right.length === 0) return [];
  const rightSet = new Set(right);
  return left.filter((entry) => rightSet.has(entry));
}

export function collectTaskCardBlockers(
  task: TaskSummary,
  allTasks: readonly TaskSummary[],
): TaskCardBlockers {
  const byTaskNumber = new Map(
    allTasks
      .filter((entry): entry is TaskSummary & { task_number: string } => !!entry.task_number)
      .map((entry) => [entry.task_number, entry]),
  );

  const dependencies = parseStringArray(task.depends_on).flatMap((depNumber): TaskBlockerRef[] => {
    const dependency = byTaskNumber.get(depNumber);
    if (!dependency) {
      return [{ kind: "dependency", taskNumber: depNumber, status: "unknown" }];
    }
    if (dependency.status === "done") {
      return [];
    }
    return [{
      kind: "dependency",
      taskId: dependency.id,
      taskNumber: dependency.task_number ?? depNumber,
      status: dependency.status,
    }];
  });

  const mine = shouldApplyFileConflictGate(task) ? parseStringArray(task.planned_files) : [];
  const fileConflicts = mine.length === 0
    ? []
    : allTasks.flatMap((candidate): TaskBlockerRef[] => {
      if (candidate.id === task.id) return [];
      if (!ACTIVE_EDITING_STAGES.has(candidate.status)) return [];
      if (!shouldApplyFileConflictGate(candidate)) return [];
      const overlap = intersect(mine, parseStringArray(candidate.planned_files));
      if (overlap.length === 0) return [];
      return [{
        kind: "file_conflict",
        taskId: candidate.id,
        taskNumber: candidate.task_number ?? candidate.id,
        status: candidate.status,
        overlappingFiles: overlap,
      }];
    });

  return { dependencies, fileConflicts };
}

export function hasTaskCardBlockers(blockers: TaskCardBlockers | undefined): boolean {
  return !!blockers && (blockers.dependencies.length > 0 || blockers.fileConflicts.length > 0);
}
