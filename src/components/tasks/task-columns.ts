import type { Task } from "../../types/index.js";

const COLUMN_KEYS = [
  "inbox",
  "in_progress",
  "self_review",
  "pr_review",
  "done",
] as const satisfies ReadonlyArray<Task["status"]>;

export type TaskColumns = Record<(typeof COLUMN_KEYS)[number], Task[]>;

export function createEmptyTaskColumns(): TaskColumns {
  return {
    inbox: [],
    in_progress: [],
    self_review: [],
    pr_review: [],
    done: [],
  };
}

export function groupTasksByStatusStable(tasks: Task[], previous?: TaskColumns): TaskColumns {
  const next = createEmptyTaskColumns();

  for (const task of tasks) {
    if (isColumnStatus(task.status)) {
      next[task.status].push(task);
    }
  }

  if (!previous) {
    return next;
  }

  for (const key of COLUMN_KEYS) {
    if (sameTaskList(previous[key], next[key])) {
      next[key] = previous[key];
    }
  }

  return next;
}

function isColumnStatus(status: Task["status"]): status is keyof TaskColumns {
  return status in createEmptyTaskColumns();
}

function sameTaskList(previous: Task[], next: Task[]): boolean {
  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }

  return true;
}
