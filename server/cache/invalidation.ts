import type { CacheService } from "./cache-service.js";
import { CACHE_KEYS } from "./keys.js";

/**
 * Invalidate caches affected by a task status transition.
 * Deletes tasks:all + tasks:status:{old} + tasks:status:{new} in a single
 * batch del call.
 */
export async function invalidateTaskStatusChange(
  cache: CacheService | undefined,
  oldStatus: string,
  newStatus: string,
): Promise<void> {
  if (!cache) return;
  const keys = [
    CACHE_KEYS.TASKS_ALL,
    CACHE_KEYS.tasksStatus(oldStatus),
    CACHE_KEYS.tasksStatus(newStatus),
  ];
  await cache.del(keys);
}

/**
 * Invalidate caches affected by a status-preserving content update
 * (e.g. settings update, acceptance criterion toggle, title rename).
 * Deletes tasks:all + tasks:status:{status} so the per-status cache,
 * which contains full row content via `SELECT *`, is also refreshed.
 */
export async function invalidateTaskContent(
  cache: CacheService | undefined,
  status: string,
): Promise<void> {
  if (!cache) return;
  await cache.del([CACHE_KEYS.TASKS_ALL, CACHE_KEYS.tasksStatus(status)]);
}

/**
 * Invalidate task caches + agents:all. When oldStatus/newStatus are provided,
 * uses targeted status invalidation; otherwise wipes all task status caches.
 */
export async function invalidateTaskAndAgents(
  cache: CacheService | undefined,
  oldStatus?: string,
  newStatus?: string,
): Promise<void> {
  if (!cache) return;
  if (oldStatus !== undefined && newStatus !== undefined) {
    const keys = [
      CACHE_KEYS.TASKS_ALL,
      CACHE_KEYS.tasksStatus(oldStatus),
      CACHE_KEYS.tasksStatus(newStatus),
      CACHE_KEYS.AGENTS_ALL,
    ];
    await cache.del(keys);
  } else {
    await cache.del([...CACHE_KEYS.allTaskKeys(), CACHE_KEYS.AGENTS_ALL]);
  }
}

/**
 * Invalidate ALL task-related cache keys (tasks:all + every tasks:status:*).
 * Derives keys from TASK_STATUSES so new statuses are automatically covered.
 * Uses batch del for a single round-trip.
 */
export async function invalidateAllTasks(
  cache: CacheService | undefined,
): Promise<void> {
  if (!cache) return;
  await cache.del(CACHE_KEYS.allTaskKeys());
}
