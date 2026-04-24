import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { SCHEMA_SQL } from "./schema.js";

import type { TaskLogKind } from "../types/runtime.js";
import type { StatementSync } from "node:sqlite";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function seedAgent(db: DatabaseSync, id = "agent-1"): void {
  db.prepare(
    "INSERT INTO agents (id, name, cli_provider) VALUES (?, ?, 'claude')",
  ).run(id, `Agent ${id}`);
}

function seedTask(db: DatabaseSync, id = "task-1", agentId = "agent-1"): void {
  db.prepare(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Test task', 'in_progress', ?, 1000, 1000)`,
  ).run(id, agentId);
}

function getLogCount(db: DatabaseSync, taskId = "task-1"): number {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM task_logs WHERE task_id = ?",
  ).get(taskId) as { cnt: number };
  return row.cnt;
}

function getAllLogs(
  db: DatabaseSync,
  taskId = "task-1",
): Array<{ kind: string; message: string; stage: string | null; agent_id: string | null }> {
  return db.prepare(
    "SELECT kind, message, stage, agent_id FROM task_logs WHERE task_id = ? ORDER BY id",
  ).all(taskId) as Array<{ kind: string; message: string; stage: string | null; agent_id: string | null }>;
}

function createMockDb(options?: {
  exec?: (sql: string) => void;
  run?: (...args: unknown[]) => void;
}): DatabaseSync {
  const stmt = {
    run(...args: unknown[]) {
      options?.run?.(...args);
    },
  } as unknown as StatementSync;

  return {
    prepare() {
      return stmt;
    },
    exec(sql: string) {
      options?.exec?.(sql);
    },
  } as unknown as DatabaseSync;
}

const ORIGINAL_BATCH_SIZE = process.env.AO_LOG_BATCH_SIZE;
const ORIGINAL_FLUSH_MS = process.env.AO_LOG_FLUSH_MS;

afterEach(() => {
  if (ORIGINAL_BATCH_SIZE === undefined) delete process.env.AO_LOG_BATCH_SIZE;
  else process.env.AO_LOG_BATCH_SIZE = ORIGINAL_BATCH_SIZE;
  if (ORIGINAL_FLUSH_MS === undefined) delete process.env.AO_LOG_FLUSH_MS;
  else process.env.AO_LOG_FLUSH_MS = ORIGINAL_FLUSH_MS;
});

describe("LogBatchWriter", () => {
  describe("constructor and configuration", () => {
    it("uses default batchSize=500 and flushMs=50 when no options or env vars", async () => {
      delete process.env.AO_LOG_BATCH_SIZE;
      delete process.env.AO_LOG_FLUSH_MS;
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      const writer = new LogBatchWriter(db);

      assert.equal(writer.batchSize, 500);
      assert.equal(writer.flushMs, 50);
      writer.shutdown();
    });

    it("reads AO_LOG_BATCH_SIZE and AO_LOG_FLUSH_MS from environment", async () => {
      process.env.AO_LOG_BATCH_SIZE = "200";
      process.env.AO_LOG_FLUSH_MS = "100";
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      const writer = new LogBatchWriter(db);

      assert.equal(writer.batchSize, 200);
      assert.equal(writer.flushMs, 100);
      writer.shutdown();
    });

    it("constructor options override environment variables", async () => {
      process.env.AO_LOG_BATCH_SIZE = "200";
      process.env.AO_LOG_FLUSH_MS = "100";
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      const writer = new LogBatchWriter(db, { batchSize: 10, flushMs: 25 });

      assert.equal(writer.batchSize, 10);
      assert.equal(writer.flushMs, 25);
      writer.shutdown();
    });
  });

  describe("enqueue", () => {
    it("adds entries to the internal queue", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      const writer = new LogBatchWriter(db, { batchSize: 100, flushMs: 60_000 });

      writer.enqueue({
        taskId: "task-1",
        kind: "stdout",
        message: "hello",
        stage: null,
        agentId: null,
      });

      assert.equal(writer.pendingCount, 1);

      writer.enqueue({
        taskId: "task-1",
        kind: "assistant",
        message: "world",
        stage: "in_progress",
        agentId: "agent-1",
      });

      assert.equal(writer.pendingCount, 2);
      writer.shutdown();
    });

    it("triggers automatic flush when queue reaches batchSize", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 3, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "line 1", stage: null, agentId: null });
      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "line 2", stage: null, agentId: null });
      assert.equal(writer.pendingCount, 2);
      assert.equal(getLogCount(db), 0);

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "line 3", stage: null, agentId: null });
      assert.equal(writer.pendingCount, 0);
      assert.equal(getLogCount(db), 3);

      writer.shutdown();
    });

    it("keeps process-manager hot-path enqueue safe by not throwing from batch-size auto-flush failures", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 2, flushMs: 60_000 });

      const restoreConsoleError = console.error;
      const loggedErrors: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        loggedErrors.push(args);
      };

      try {
        writer.enqueue({ taskId: "task-1", kind: "stdout", message: "safe hot-path entry", stage: null, agentId: null });
        assert.doesNotThrow(() => {
          writer.enqueue({
            taskId: "task-1",
            kind: "invalid_kind" as TaskLogKind,
            message: "bad hot-path entry",
            stage: null,
            agentId: null,
          });
        });

        assert.equal(getLogCount(db), 0);
        assert.equal(writer.pendingCount, 2);
        assert.equal(
          loggedErrors.some(
            ([message]) =>
              typeof message === "string"
              && message.includes("batch-size auto-flush failed; retaining queued logs in memory for later flush/retry"),
          ),
          true,
        );
        assert.equal(writer.shutdown(), false);
      } finally {
        console.error = restoreConsoleError;
      }
    });
  });

  describe("flush", () => {
    it("inserts all queued entries in a single transaction", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      for (let i = 0; i < 5; i++) {
        writer.enqueue({
          taskId: "task-1",
          kind: "stdout",
          message: `line ${i}`,
          stage: "in_progress",
          agentId: "agent-1",
        });
      }

      assert.equal(getLogCount(db), 0);
      writer.flush();
      assert.equal(getLogCount(db), 5);
      assert.equal(writer.pendingCount, 0);

      const logs = getAllLogs(db);
      assert.equal(logs[0].message, "line 0");
      assert.equal(logs[4].message, "line 4");
      assert.equal(logs[0].kind, "stdout");
      assert.equal(logs[0].stage, "in_progress");
      assert.equal(logs[0].agent_id, "agent-1");

      writer.shutdown();
    });

    it("is a no-op when queue is empty", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      const writer = new LogBatchWriter(db, { batchSize: 100, flushMs: 60_000 });

      writer.flush();
      assert.equal(writer.pendingCount, 0);

      writer.shutdown();
    });

    it("preserves entry order across multiple flushes", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "first", stage: null, agentId: null });
      writer.enqueue({ taskId: "task-1", kind: "assistant", message: "second", stage: null, agentId: null });
      writer.flush();

      writer.enqueue({ taskId: "task-1", kind: "tool_call", message: "third", stage: null, agentId: null });
      writer.flush();

      const logs = getAllLogs(db);
      assert.equal(logs.length, 3);
      assert.equal(logs[0].message, "first");
      assert.equal(logs[0].kind, "stdout");
      assert.equal(logs[1].message, "second");
      assert.equal(logs[1].kind, "assistant");
      assert.equal(logs[2].message, "third");
      assert.equal(logs[2].kind, "tool_call");

      writer.shutdown();
    });

    it("handles entries for multiple tasks in the same batch", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db, "task-1");
      seedTask(db, "task-2");
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "from task 1", stage: null, agentId: null });
      writer.enqueue({ taskId: "task-2", kind: "stdout", message: "from task 2", stage: null, agentId: null });
      writer.enqueue({ taskId: "task-1", kind: "assistant", message: "task 1 again", stage: null, agentId: null });
      writer.flush();

      assert.equal(getLogCount(db, "task-1"), 2);
      assert.equal(getLogCount(db, "task-2"), 1);

      writer.shutdown();
    });
  });

  describe("timer-based flush", () => {
    it("flushes after flushMs elapses", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 30 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "delayed", stage: null, agentId: null });
      assert.equal(getLogCount(db), 0);

      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(getLogCount(db), 1);
      assert.equal(writer.pendingCount, 0);

      writer.shutdown();
    });

    it("does not surface non-FK errors as uncaught exceptions and keeps the batch queued", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 20 });

      const uncaughtErrors: unknown[] = [];
      const loggedErrors: unknown[][] = [];
      const onUncaughtException = (error: unknown) => {
        uncaughtErrors.push(error);
      };
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        loggedErrors.push(args);
      };
      process.once("uncaughtException", onUncaughtException);

      try {
        writer.enqueue({
          taskId: "task-1",
          kind: "invalid_kind" as TaskLogKind,
          message: "bad timer batch",
          stage: null,
          agentId: null,
        });

        await new Promise((resolve) => setTimeout(resolve, 70));

        assert.equal(uncaughtErrors.length, 0);
        assert.equal(getLogCount(db), 0);
        assert.equal(writer.pendingCount, 1);
        assert.equal(loggedErrors.length > 0, true);
      } finally {
        process.removeListener("uncaughtException", onUncaughtException);
        console.error = originalConsoleError;
        const originalShutdownConsoleError = console.error;
        console.error = () => {};
        try {
          writer.shutdown();
        } finally {
          console.error = originalShutdownConsoleError;
        }
      }
    });
  });

  describe("shutdown", () => {
    it("flushes remaining entries on shutdown", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "before shutdown", stage: null, agentId: null });
      writer.enqueue({ taskId: "task-1", kind: "assistant", message: "also before", stage: null, agentId: null });
      assert.equal(getLogCount(db), 0);

      writer.shutdown();
      assert.equal(getLogCount(db), 2);
      assert.equal(writer.pendingCount, 0);
    });

    it("is idempotent (calling shutdown twice does not throw)", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      const writer = new LogBatchWriter(db, { batchSize: 100, flushMs: 60_000 });

      writer.shutdown();
      writer.shutdown();
    });

    it("enqueue after shutdown does not throw but entries are not queued", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      const writer = new LogBatchWriter(db, { batchSize: 100, flushMs: 60_000 });

      writer.shutdown();
      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "after shutdown", stage: null, agentId: null });
      assert.equal(writer.pendingCount, 0);
    });

    it("returns false and keeps pending entries queued when flush fails during shutdown", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      const originalConsoleError = console.error;
      const loggedErrors: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        loggedErrors.push(args);
      };

      try {
        writer.enqueue({
          taskId: "task-1",
          kind: "invalid_kind" as TaskLogKind,
          message: "bad shutdown batch",
          stage: null,
          agentId: null,
        });

        const drained = writer.shutdown();

        assert.equal(drained, false);
        assert.equal(getLogCount(db), 0);
        assert.equal(writer.pendingCount, 1);
        assert.equal(loggedErrors.length > 0, true);
      } finally {
        console.error = originalConsoleError;
      }
    });
  });

  describe("error handling", () => {
    it("swallows FK violation when task is deleted mid-stream", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "will survive", stage: null, agentId: null });
      writer.enqueue({ taskId: "nonexistent-task", kind: "stdout", message: "FK fail", stage: null, agentId: null });

      assert.doesNotThrow(() => writer.flush());
      writer.shutdown();
    });

    it("re-throws non-FK database errors", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({
        taskId: "task-1",
        kind: "invalid_kind" as TaskLogKind,
        message: "CHECK constraint fail",
        stage: null,
        agentId: null,
      });

      assert.throws(() => writer.flush());

      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        writer.shutdown();
      } finally {
        console.error = originalConsoleError;
      }
    });

    it("rolls back the entire batch on non-FK error", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "good entry", stage: null, agentId: null });
      writer.enqueue({
        taskId: "task-1",
        kind: "invalid_kind" as TaskLogKind,
        message: "bad entry",
        stage: null,
        agentId: null,
      });

      try { writer.flush(); } catch { /* expected */ }
      assert.equal(getLogCount(db), 0, "all entries should be rolled back");

      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        writer.shutdown();
      } finally {
        console.error = originalConsoleError;
      }
    });

    it("re-queues the failed batch on non-FK error", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "good entry", stage: null, agentId: null });
      writer.enqueue({
        taskId: "task-1",
        kind: "invalid_kind" as TaskLogKind,
        message: "bad entry",
        stage: null,
        agentId: null,
      });

      assert.throws(() => writer.flush());
      assert.equal(getLogCount(db), 0);
      assert.equal(writer.pendingCount, 2);

      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        assert.equal(writer.shutdown(), false);
      } finally {
        console.error = originalConsoleError;
      }
    });

    it("re-queues entries when BEGIN fails before the transaction starts", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const beginError = new Error("BEGIN failed");
      const db = createMockDb({
        exec(sql) {
          if (sql === "BEGIN") throw beginError;
        },
      });
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "line 1", stage: null, agentId: null });

      assert.throws(() => writer.flush(), (error) => error === beginError);
      assert.equal(writer.pendingCount, 1);

      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        assert.equal(writer.shutdown(), false);
      } finally {
        console.error = originalConsoleError;
      }
    });

    it("preserves the original error when rollback also fails", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const runError = new Error("insert failed");
      const rollbackError = new Error("rollback failed");
      const db = createMockDb({
        exec(sql) {
          if (sql === "ROLLBACK") throw rollbackError;
        },
        run() {
          throw runError;
        },
      });
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        writer.enqueue({ taskId: "task-1", kind: "stdout", message: "line 1", stage: null, agentId: null });
        assert.throws(() => writer.flush(), (error) => error === runError);
        assert.equal(writer.pendingCount, 1);
        assert.equal(writer.shutdown(), false);
      } finally {
        console.error = originalConsoleError;
      }
    });
  });

  describe("performance metrics", () => {
    it("increments dbLogInserts counter after a successful flush", async () => {
      const { metrics } = await import("../perf/metrics.js");
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      const before = metrics.dbLogInserts;
      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "perf test", stage: null, agentId: null });
      writer.flush();

      assert.equal(metrics.dbLogInserts, before + 1);
      assert.ok(metrics.dbLogInsertTotalMs >= 0, "total duration should be non-negative");

      writer.shutdown();
    });

    it("does not increment dbLogInserts on empty flush", async () => {
      const { metrics } = await import("../perf/metrics.js");
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      const writer = new LogBatchWriter(db, { batchSize: 100, flushMs: 60_000 });

      const before = metrics.dbLogInserts;
      writer.flush();
      assert.equal(metrics.dbLogInserts, before);
      writer.shutdown();
    });
  });

  describe("batch size boundary", () => {
    it("flushes exactly at batchSize, not before", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 5, flushMs: 60_000 });

      for (let i = 0; i < 4; i++) {
        writer.enqueue({ taskId: "task-1", kind: "stdout", message: `line ${i}`, stage: null, agentId: null });
      }
      assert.equal(writer.pendingCount, 4);
      assert.equal(getLogCount(db), 0);

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "line 4", stage: null, agentId: null });
      assert.equal(writer.pendingCount, 0);
      assert.equal(getLogCount(db), 5);

      writer.shutdown();
    });

    it("handles rapid successive flushes from multiple batch-size thresholds", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 2, flushMs: 60_000 });

      for (let i = 0; i < 6; i++) {
        writer.enqueue({ taskId: "task-1", kind: "stdout", message: `rapid ${i}`, stage: null, agentId: null });
      }

      assert.equal(writer.pendingCount, 0);
      assert.equal(getLogCount(db), 6);

      writer.shutdown();
    });
  });

  describe("large batch", () => {
    it("handles 500 entries in a single flush", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      for (let i = 0; i < 500; i++) {
        writer.enqueue({ taskId: "task-1", kind: "stdout", message: `bulk line ${i}`, stage: "in_progress", agentId: "agent-1" });
      }
      writer.flush();

      assert.equal(getLogCount(db), 500);
      assert.equal(writer.pendingCount, 0);

      writer.shutdown();
    });
  });

  describe("all TaskLogKind values", () => {
    it("accepts every valid TaskLogKind", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      const kinds: TaskLogKind[] = ["stdout", "stderr", "system", "thinking", "assistant", "tool_call", "tool_result"];
      for (const kind of kinds) {
        writer.enqueue({ taskId: "task-1", kind, message: `msg for ${kind}`, stage: null, agentId: null });
      }
      writer.flush();

      const logs = getAllLogs(db);
      assert.equal(logs.length, kinds.length);
      for (let i = 0; i < kinds.length; i++) {
        assert.equal(logs[i].kind, kinds[i]);
        assert.equal(logs[i].message, `msg for ${kinds[i]}`);
      }

      writer.shutdown();
    });
  });

  describe("stage and agentId metadata", () => {
    it("persists stage and agent_id correctly", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db);
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "with metadata", stage: "review", agentId: "agent-1" });
      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "without metadata", stage: null, agentId: null });
      writer.flush();

      const logs = getAllLogs(db);
      assert.equal(logs[0].stage, "review");
      assert.equal(logs[0].agent_id, "agent-1");
      assert.equal(logs[1].stage, null);
      assert.equal(logs[1].agent_id, null);

      writer.shutdown();
    });
  });

  describe("FK violation isolation", () => {
    it("does not lose entries from valid tasks when another task has FK violation", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db, "task-1");
      seedTask(db, "task-2");
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "good from task-1", stage: null, agentId: null });
      writer.enqueue({ taskId: "nonexistent-task", kind: "stdout", message: "FK fail", stage: null, agentId: null });
      writer.enqueue({ taskId: "task-2", kind: "stdout", message: "good from task-2", stage: null, agentId: null });

      writer.flush();

      assert.equal(getLogCount(db, "task-1"), 1);
      assert.equal(getLogCount(db, "task-2"), 1);

      writer.shutdown();
    });

    it("isolates FK failure to the offending task_id only", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db, "task-1");
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "line 1", stage: null, agentId: null });
      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "line 2", stage: null, agentId: null });
      writer.enqueue({ taskId: "deleted-task", kind: "stdout", message: "orphan 1", stage: null, agentId: null });
      writer.enqueue({ taskId: "deleted-task", kind: "stdout", message: "orphan 2", stage: null, agentId: null });

      writer.flush();

      assert.equal(getLogCount(db, "task-1"), 2);

      writer.shutdown();
    });
  });

  describe("flushForTask", () => {
    it("flushes only entries for the specified task_id", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db, "task-1");
      seedTask(db, "task-2");
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "t1 line", stage: null, agentId: null });
      writer.enqueue({ taskId: "task-2", kind: "stdout", message: "t2 line", stage: null, agentId: null });
      writer.enqueue({ taskId: "task-1", kind: "assistant", message: "t1 assist", stage: null, agentId: null });

      assert.equal(writer.pendingCount, 3);

      writer.flushForTask("task-1");

      assert.equal(getLogCount(db, "task-1"), 2);
      assert.equal(getLogCount(db, "task-2"), 0);
      assert.equal(writer.pendingCount, 1);

      writer.shutdown();
      assert.equal(getLogCount(db, "task-2"), 1);
    });

    it("is a no-op when no entries exist for the given task_id", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db, "task-1");
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "t1", stage: null, agentId: null });
      writer.flushForTask("task-999");

      assert.equal(writer.pendingCount, 1);
      assert.equal(getLogCount(db, "task-1"), 0);

      writer.shutdown();
    });

    it("handles FK violation for the flushed task gracefully", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db, "task-1");
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({ taskId: "task-1", kind: "stdout", message: "good", stage: null, agentId: null });
      writer.enqueue({ taskId: "nonexistent", kind: "stdout", message: "bad", stage: null, agentId: null });

      assert.doesNotThrow(() => writer.flushForTask("nonexistent"));
      assert.equal(writer.pendingCount, 1);

      writer.shutdown();
      assert.equal(getLogCount(db, "task-1"), 1);
    });

    it("restores the original queue when flushForTask hits a non-FK error", async () => {
      const { LogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();
      seedAgent(db);
      seedTask(db, "task-1");
      seedTask(db, "task-2");
      const writer = new LogBatchWriter(db, { batchSize: 1000, flushMs: 60_000 });

      writer.enqueue({
        taskId: "task-1",
        kind: "invalid_kind" as TaskLogKind,
        message: "bad task-1 entry",
        stage: null,
        agentId: null,
      });
      writer.enqueue({ taskId: "task-2", kind: "stdout", message: "task-2 entry", stage: null, agentId: null });

      assert.throws(() => writer.flushForTask("task-1"));
      assert.equal(getLogCount(db, "task-1"), 0);
      assert.equal(getLogCount(db, "task-2"), 0);
      assert.equal(writer.pendingCount, 2);

      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        assert.equal(writer.shutdown(), false);
      } finally {
        console.error = originalConsoleError;
      }
    });
  });

  describe("singleton accessor", () => {
    it("initLogBatchWriter sets the singleton and getLogBatchWriter returns it", async () => {
      const { initLogBatchWriter, getLogBatchWriter } = await import("./log-batch-writer.js");
      const db = createDb();

      const writer = initLogBatchWriter(db, { batchSize: 10, flushMs: 60_000 });
      assert.ok(writer);
      assert.strictEqual(getLogBatchWriter(), writer);

      writer.shutdown();
    });
  });
});
