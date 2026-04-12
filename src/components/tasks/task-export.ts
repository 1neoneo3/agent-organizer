import { exportTasksCsvUrl } from "../../api/endpoints.js";
import type { Task } from "../../types/index.js";

export interface CompletedTaskExportState {
  completedCount: number;
  hasCompletedTasks: boolean;
  href: string;
}

export function getCompletedTaskExportState(tasks: Task[]): CompletedTaskExportState {
  const completedCount = tasks.filter((task) => task.status === "done").length;

  return {
    completedCount,
    hasCompletedTasks: completedCount > 0,
    href: exportTasksCsvUrl("done"),
  };
}
