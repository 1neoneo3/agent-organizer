import type { Task } from "../../types/index.js";

export const TASK_BOARD_COLUMNS = [
  { key: "inbox", label: "INBOX", town: "Inbox", accentColor: "var(--status-inbox)" },
  { key: "refinement", label: "REFINEMENT", town: "Refinement", accentColor: "var(--status-refinement)" },
  { key: "in_progress", label: "IN PROGRESS", town: "In Progress", accentColor: "var(--status-progress)" },
  { key: "self_review", label: "SELF REVIEW", town: "Self Review", accentColor: "var(--status-review)" },
  { key: "test_generation", label: "TEST GEN", town: "Test Generation", accentColor: "var(--status-test-gen)" },
  { key: "ci_check", label: "CI CHECK", town: "CI Check", accentColor: "var(--status-ci-check)" },
  { key: "qa_testing", label: "QA TESTING", town: "QA Testing", accentColor: "var(--status-qa)" },
  { key: "pr_review", label: "PR REVIEW", town: "PR Review", accentColor: "var(--status-review)" },
  { key: "human_review", label: "HUMAN REVIEW", town: "Human Review", accentColor: "var(--status-human-review)" },
  { key: "done", label: "DONE", town: "Done", accentColor: "var(--status-done)" },
  { key: "cancelled", label: "CANCELLED", town: "Cancelled", accentColor: "var(--status-cancelled)" },
] as const satisfies ReadonlyArray<{
  key: Task["status"];
  label: string;
  town: string;
  accentColor: string;
}>;

const COLUMN_KEYS = TASK_BOARD_COLUMNS.map((column) => column.key) as ReadonlyArray<Task["status"]>;

export type TaskColumns = Record<(typeof COLUMN_KEYS)[number], Task[]>;

export function createEmptyTaskColumns(): TaskColumns {
  return {
    inbox: [],
    refinement: [],
    in_progress: [],
    self_review: [],
    test_generation: [],
    qa_testing: [],
    pr_review: [],
    human_review: [],
    ci_check: [],
    done: [],
    cancelled: [],
  };
}

export function groupTasksByStatusStable(tasks: Task[], previous?: TaskColumns): TaskColumns {
  const next = createEmptyTaskColumns();

  for (const task of tasks) {
    if (isColumnStatus(task.status)) {
      next[task.status].push(task);
    }
  }

  for (const key of COLUMN_KEYS) {
    next[key] = sortTasksByCreatedAtDesc(next[key]);
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

function sortTasksByCreatedAtDesc(tasks: Task[]): Task[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const createdAtDiff = right.task.created_at - left.task.created_at;
      if (createdAtDiff !== 0) {
        return createdAtDiff;
      }

      return left.index - right.index;
    })
    .map(({ task }) => task);
}
