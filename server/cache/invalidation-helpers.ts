import type { CacheService } from "./cache-service.js";
import { TASK_STATUSES } from "../domain/task-status.js";

const TASK_STATUS_KEYS = TASK_STATUSES.map((s) => `tasks:status:${s}`);
const ALL_TASK_KEYS = ["tasks:all", ...TASK_STATUS_KEYS];

export function invalidateTaskListOnly(cache?: CacheService): void {
  if (!cache) return;
  for (const key of ALL_TASK_KEYS) {
    void cache.del(key);
  }
}

export function invalidateTaskAndAgents(cache?: CacheService): void {
  if (!cache) return;
  invalidateTaskListOnly(cache);
  void cache.del("agents:all");
}

export function invalidateTaskStatusChange(
  cache: CacheService | undefined,
  fromStatus: string,
  toStatus: string,
): void {
  if (!cache) return;
  void cache.del("tasks:all");
  void cache.del(`tasks:status:${fromStatus}`);
  if (fromStatus !== toStatus) {
    void cache.del(`tasks:status:${toStatus}`);
  }
  void cache.del("agents:all");
}

export function invalidateAllTasks(cache?: CacheService): void {
  invalidateTaskListOnly(cache);
}
