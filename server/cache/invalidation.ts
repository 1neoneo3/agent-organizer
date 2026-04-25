import type { CacheService } from "./cache-service.js";
import { CACHE_KEYS } from "./keys.js";

/**
 * Invalidate caches affected by a task status transition.
 * Deletes tasks:all + tasks:status:{old} + tasks:status:{new} in a single
 * batch del call.
 */
export async function invalidateTaskStatusChange(
  cache: CacheService,
  oldStatus: string,
  newStatus: string,
): Promise<void> {
  const keys = [
    CACHE_KEYS.TASKS_ALL,
    CACHE_KEYS.tasksStatus(oldStatus),
    CACHE_KEYS.tasksStatus(newStatus),
  ];
  await cache.del(keys);
}

/**
 * Invalidate tasks:all only. Use when task metadata changed but the status
 * did not (e.g. settings update, acceptance criterion toggle).
 */
export async function invalidateTaskListOnly(
  cache: CacheService,
): Promise<void> {
  await cache.del(CACHE_KEYS.TASKS_ALL);
}

/**
 * Invalidate task caches + agents:all. When oldStatus/newStatus are provided,
 * uses targeted status invalidation; otherwise wipes all task status caches.
 */
export async function invalidateTaskAndAgents(
  cache: CacheService,
  oldStatus?: string,
  newStatus?: string,
): Promise<void> {
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
  cache: CacheService,
): Promise<void> {
  await cache.del(CACHE_KEYS.allTaskKeys());
}
