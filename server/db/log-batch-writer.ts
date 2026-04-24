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

    this.timer = setInterval(() => this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  enqueue(entry: LogEntry): void {
    if (this.closed) return;
    this.queue.push(entry);
    if (this.queue.length >= this.batchSize) {
      this.flush();
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

    const grouped = groupByTaskId(batch);
    const t0 = performance.now();
    try {
      for (const entries of grouped.values()) {
        this.flushGroup(entries);
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
      this.flushGroup(target);
    } finally {
      recordDbLogInsertMs(performance.now() - t0);
    }
  }

  shutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
    this.closed = true;
  }

  private flushGroup(entries: LogEntry[]): void {
    this.db.exec("BEGIN");
    try {
      for (const entry of entries) {
        this.stmt.run(entry.taskId, entry.kind, entry.message, entry.stage, entry.agentId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      const isFkViolation =
        error instanceof Error &&
        /FOREIGN KEY constraint failed/i.test(error.message);
      if (!isFkViolation) {
        throw error;
      }
    }
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
