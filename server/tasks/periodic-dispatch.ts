import type { DatabaseSync } from "node:sqlite";
import type { CacheService } from "../cache/cache-service.js";
import type { WsHub } from "../ws/hub.js";
import { spawnAgent as defaultSpawnAgent } from "../spawner/process-manager.js";
import { autoDispatchTask } from "./auto-dispatch.js";

interface PeriodicDispatchOptions {
  autoAssign: boolean;
  autoRun: boolean;
  cache?: CacheService;
  spawnAgent?: typeof defaultSpawnAgent;
}

export function dispatchInboxTasks(
  db: DatabaseSync,
  ws: WsHub,
  options: PeriodicDispatchOptions,
): string[] {
  if (!options.autoRun) {
    return [];
  }

  const inboxTasks = db.prepare(
    "SELECT id FROM tasks WHERE status = 'inbox' ORDER BY priority DESC, created_at ASC"
  ).all() as Array<{ id: string }>;

  const startedTaskIds: string[] = [];

  for (const { id } of inboxTasks) {
    const task = autoDispatchTask(db, ws, id, options);
    if (task?.status === "in_progress") {
      startedTaskIds.push(task.id);
    }
  }

  return startedTaskIds;
}

export function startPeriodicInboxDispatch(
  db: DatabaseSync,
  ws: WsHub,
  options: PeriodicDispatchOptions,
  intervalMs = 60_000,
): ReturnType<typeof setInterval> {
  const run = () => {
    try {
      dispatchInboxTasks(db, ws, options);
    } catch (error) {
      console.error("[inbox-auto-dispatch]", error);
    }
  };

  run();
  return setInterval(run, intervalMs);
}
