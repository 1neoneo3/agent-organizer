import type { TaskSummary } from "../../types/index.js";

export function formatControllerTaskTitle(task: Pick<TaskSummary, "title" | "controller_stage" | "parent_task_number" | "parent_task_title">): string {
  if (
    task.controller_stage === "integrate" &&
    task.title === "Integrate controller results" &&
    task.parent_task_number
  ) {
    const parentLabel = task.parent_task_title
      ? `${task.parent_task_number} ${task.parent_task_title}`
      : task.parent_task_number;
    return `Integrate controller results: ${parentLabel}`;
  }
  return task.title;
}
