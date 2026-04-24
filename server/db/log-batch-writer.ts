import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { TaskLogKind } from "../types/runtime.js";
import { recordDbLogInsertMs } from "../perf/metrics.js";

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_FLUSH_MS = 50;

export interface LogEntry {
  taskId: string;
  kind: TaskLogKind;
  message: string;
  stage: string | null;
  agentId: string | null;
}

export class LogBatchWriter {
  readonly batchSize: number;
  readonly flushMs: number;

  private queue: LogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stmt: StatementSync;
  private db: DatabaseSync;
  private closed = false;

  constructor(
    db: DatabaseSync,
    options?: { batchSize?: number; flushMs?: number },
  ) {
    this.db = db;
    this.batchSize = options?.batchSize
      ?? (process.env.AO_LOG_BATCH_SIZE ? Number(process.env.AO_LOG_BATCH_SIZE) : DEFAULT_BATCH_SIZE);
    this.flushMs = options?.flushMs
      ?? (process.env.AO_LOG_FLUSH_MS ? Number(process.env.AO_LOG_FLUSH_MS) : DEFAULT_FLUSH_MS);

    this.stmt = db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, agent_id) VALUES (?, ?, ?, ?, ?)",
    );

    this.timer = setInterval(() => this.flushFromTimer(), this.flushMs);
    this.timer.unref?.();
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * `enqueue()` is on the stdout/stderr hot path, so its batch-size
   * auto-flush must never throw. On failure we retain the queue in
   * memory and rely on later auto/manual flush attempts to retry.
   */
  enqueue(entry: LogEntry): void {
    if (this.closed) return;
    this.queue.push(entry);
    if (this.queue.length >= this.batchSize) {
      this.flushWithoutThrow("batch-size");
    }
  }

  /**
   * Flush all queued entries, grouped by task_id. Each task_id gets its
   * own transaction so that an FK violation (task deleted mid-stream) for
   * one task cannot cause entries from other tasks to be lost.
   */
  flush(): void {
    if (this.queue.length === 0) return;

    const batch = this.queue;
    this.queue = [];

    const t0 = performance.now();
    try {
      const result = this.tryFlushEntries(batch);
      if (!result.ok) {
        this.requeue(result.pendingEntries);
        throw result.error;
      }
    } finally {
      recordDbLogInsertMs(performance.now() - t0);
    }
  }

  /**
   * Flush only entries for the given task_id. Leaves entries for other
   * tasks in the queue. Use this as a pre-step before any close handler
   * logic that reads task_logs for a specific task.
   */
  flushForTask(taskId: string): void {
    if (this.closed) return;

    const originalQueue = this.queue;
    const remaining: LogEntry[] = [];
    const target: LogEntry[] = [];

    for (const entry of this.queue) {
      if (entry.taskId === taskId) {
        target.push(entry);
      } else {
        remaining.push(entry);
      }
    }

    this.queue = remaining;

    if (target.length === 0) return;

    const t0 = performance.now();
    try {
      const result = this.tryFlushEntries(target);
      if (!result.ok) {
        this.queue = originalQueue;
        throw result.error;
      }
    } finally {
      recordDbLogInsertMs(performance.now() - t0);
    }
  }

  shutdown(): boolean {
    if (this.closed) return true;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    try {
      this.flush();
      this.closed = true;
      return true;
    } catch (error) {
      this.reportFlushFailure("shutdown flush failed; retaining queued logs in memory", error);
      return false;
    }
  }

  private flushGroup(entries: LogEntry[]): void {
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN");
      transactionStarted = true;
      for (const entry of entries) {
        this.stmt.run(entry.taskId, entry.kind, entry.message, entry.stage, entry.agentId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db.exec("ROLLBACK");
        } catch (rollbackError) {
          this.reportRollbackFailure(rollbackError, error);
        }
      }
      const isFkViolation =
        error instanceof Error &&
        /FOREIGN KEY constraint failed/i.test(error.message);
      if (!isFkViolation) {
        throw error;
      }
    }
  }

  private flushFromTimer(): void {
    if (this.closed || this.queue.length === 0) return;

    this.flushWithoutThrow("timer");
  }

  private flushWithoutThrow(trigger: "batch-size" | "timer"): void {
    try {
      this.flush();
    } catch (error) {
      const message = trigger === "batch-size"
        ? "batch-size auto-flush failed; retaining queued logs in memory for later flush/retry"
        : "timer flush failed; retaining queued logs in memory for later flush/retry";
      this.reportFlushFailure(message, error);
    }
  }

  private tryFlushEntries(entries: LogEntry[]): FlushResult {
    const grouped = groupByTaskId(entries);
    const orderedTaskIds = [...grouped.keys()];

    for (let index = 0; index < orderedTaskIds.length; index += 1) {
      const taskId = orderedTaskIds[index];
      const group = grouped.get(taskId);
      if (!group) continue;

      try {
        this.flushGroup(group);
      } catch (error) {
        const pendingTaskIds = new Set(orderedTaskIds.slice(index));
        return {
          ok: false,
          error,
          pendingEntries: entries.filter((entry) => pendingTaskIds.has(entry.taskId)),
        };
      }
    }

    return { ok: true };
  }

  private requeue(entries: LogEntry[]): void {
    if (entries.length === 0) return;
    this.queue = [...entries, ...this.queue];
  }

  private reportFlushFailure(message: string, error: unknown): void {
    console.error(
      `[log-batch-writer] ${message} (pending=${this.pendingCount})`,
      error,
    );
  }

  private reportRollbackFailure(rollbackError: unknown, originalError: unknown): void {
    console.error(
      "[log-batch-writer] rollback failed while handling log batch error; preserving original error",
      { rollbackError, originalError },
    );
  }
}

// ---- Singleton accessor ----

let singleton: LogBatchWriter | null = null;

export function initLogBatchWriter(
  db: DatabaseSync,
  options?: { batchSize?: number; flushMs?: number },
): LogBatchWriter {
  singleton = new LogBatchWriter(db, options);
  return singleton;
}

export function getLogBatchWriter(): LogBatchWriter | null {
  return singleton;
}

// ---- Helpers ----

function groupByTaskId(entries: LogEntry[]): Map<string, LogEntry[]> {
  const map = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const list = map.get(entry.taskId);
    if (list) {
      list.push(entry);
    } else {
      map.set(entry.taskId, [entry]);
    }
  }
  return map;
}

type FlushResult =
  | { ok: true }
  | { ok: false; error: unknown; pendingEntries: LogEntry[] };
