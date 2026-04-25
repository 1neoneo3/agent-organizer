import { TASK_STATUSES } from "../domain/task-status.js";

export const CACHE_KEYS = {
  TASKS_ALL: "tasks:all",
  AGENTS_ALL: "agents:all",

  tasksStatus(status: string): string {
    return `tasks:status:${status}`;
  },

  allTaskKeys(): string[] {
    return [
      CACHE_KEYS.TASKS_ALL,
      ...TASK_STATUSES.map((s) => CACHE_KEYS.tasksStatus(s)),
    ];
  },
} as const;
