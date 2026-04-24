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

  flush(): void {
    if (this.queue.length === 0) return;

    const batch = this.queue;
    this.queue = [];

    const t0 = performance.now();
    this.db.exec("BEGIN");
    try {
      for (const entry of batch) {
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
    recordDbLogInsertMs(performance.now() - t0);
  }

  shutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
    this.closed = true;
  }
}
