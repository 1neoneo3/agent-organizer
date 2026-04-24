import type { Task } from "../types/runtime.js";

export type TaskUpdateKey = Exclude<keyof Task, "id">;

export function pickTaskUpdate(
  task: Pick<Task, "id"> & Partial<Task>,
  keys: readonly TaskUpdateKey[],
): Partial<Task> & { id: string } {
  const payload: Partial<Task> & { id: string } = { id: task.id };
  const target = payload as Record<string, unknown>;

  for (const key of keys) {
    const value = task[key];
    if (Object.prototype.hasOwnProperty.call(task, key) && value !== undefined) {
      target[key] = value;
    }
  }

  return payload;
}
