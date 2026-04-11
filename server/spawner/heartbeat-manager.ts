/**
 * Consolidated heartbeat scheduler.
 *
 * Previously every spawned agent started its own `setInterval` to stamp
 * `tasks.last_heartbeat_at` every 30 seconds. With N concurrent tasks
 * this produced N separate timer wakeups and N independent writer-lock
 * acquisitions every 30s — harmless at 1-2 tasks, noticeable at 10+.
 *
 * This module centralizes the work: a single `setInterval` walks the
 * active-task set and writes every heartbeat in one SQLite transaction,
 * so the writer lock is taken once per tick regardless of concurrency.
 *
 * Lifecycle:
 *   - `initHeartbeatManager(db)` is called once at server startup.
 *   - `spawnAgent` registers a task id when the child process starts.
 *   - All exit paths (close / error / spawn-error) unregister the id.
 *   - `start()` begins the periodic tick; `stop()` clears it.
 */

import type { DatabaseSync } from "node:sqlite";
import { recordHeartbeatWrite } from "../perf/metrics.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatManager {
  /** Add a task id to the active set and stamp its heartbeat immediately. */
  registerTask(taskId: string): void;
  /** Remove a task id from the active set. Safe to call if not registered. */
  unregisterTask(taskId: string): void;
  /** Begin the periodic scheduler. No-op if already running. */
  start(intervalMs?: number): void;
  /** Stop the periodic scheduler. No-op if already stopped. */
  stop(): void;
  /** Run one tick synchronously — used by tests and the initial startup beat. */
  tick(): void;
  /** Count of currently active task ids — diagnostics / tests. */
  size(): number;
}

export function createHeartbeatManager(db: DatabaseSync): HeartbeatManager {
  const activeTasks = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const updateStmt = db.prepare("UPDATE tasks SET last_heartbeat_at = ? WHERE id = ?");

  function writeHeartbeatsForAll(): void {
    if (activeTasks.size === 0) return;
    const now = Date.now();

    // Wrap all UPDATEs in a single transaction so the writer lock is
    // acquired exactly once per tick even if many tasks are registered.
    db.exec("BEGIN");
    try {
      for (const taskId of activeTasks) {
        updateStmt.run(now, taskId);
        recordHeartbeatWrite();
      }
      db.exec("COMMIT");
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Double-fault during rollback — DB is probably shutting down,
        // nothing useful we can do.
      }
    }
  }

  return {
    registerTask(taskId) {
      activeTasks.add(taskId);
      // Stamp immediately so a task that transitions into an auto-stage
      // right after spawn does not briefly look stuck before the first
      // scheduler tick arrives.
      try {
        updateStmt.run(Date.now(), taskId);
        recordHeartbeatWrite();
      } catch {
        // Ignore — DB may be shutting down
      }
    },
    unregisterTask(taskId) {
      activeTasks.delete(taskId);
    },
    start(intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS) {
      if (timer) return;
      timer = setInterval(writeHeartbeatsForAll, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick() {
      writeHeartbeatsForAll();
    },
    size() {
      return activeTasks.size;
    },
  };
}

// ---- Singleton accessor ----
//
// Production code (process-manager) imports `getHeartbeatManager()` and
// does not know which db instance it is talking to. Tests create isolated
// managers via `createHeartbeatManager(db)` directly and bypass the
// singleton entirely.

let singleton: HeartbeatManager | null = null;

export function initHeartbeatManager(db: DatabaseSync): HeartbeatManager {
  singleton = createHeartbeatManager(db);
  return singleton;
}

export function getHeartbeatManager(): HeartbeatManager | null {
  return singleton;
}

export function resetHeartbeatManagerForTests(): void {
  singleton?.stop();
  singleton = null;
}
