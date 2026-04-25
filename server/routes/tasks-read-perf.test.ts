import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import express from "express";
import type { CacheService } from "../cache/cache-service.js";
import { SCHEMA_SQL } from "../db/schema.js";
import { metrics } from "../perf/metrics.js";
import { createTasksRouter } from "./tasks.js";
import { clearPendingInteractivePrompt, restorePendingInteractivePrompts } from "../spawner/process-manager.js";

function resetAllMetrics(): void {
  metrics.wsBroadcasts = 0;
  metrics.wsBroadcastBytes = 0;
  metrics.dbLogInserts = 0;
  metrics.dbLogInsertTotalMs = 0;
  metrics.dbLogInsertSlow = 0;
  metrics.dbLogInsertMaxMs = 0;
  metrics.stdoutChunks = 0;
  metrics.stdoutChunkTotalMs = 0;
  metrics.stdoutChunkSlow = 0;
  metrics.stdoutChunkMaxMs = 0;
  metrics.heartbeatWrites = 0;
  for (const key of Object.keys(metrics.readApi)) delete metrics.readApi[key];
  for (const key of Object.keys(metrics.wsEventTypes)) delete metrics.wsEventTypes[key];
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function createCache(): CacheService {
  const store = new Map<string, unknown>();

  return {
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T | undefined) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async del(keyOrKeys: string | string[]): Promise<void> {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      for (const k of keys) store.delete(k);
    },
    async invalidatePattern(pattern: string): Promise<void> {
      const prefix = pattern.replace(/\*$/, "");
      for (const key of Array.from(store.keys())) {
        if (key.startsWith(prefix)) {
          store.delete(key);
        }
      }
    },
    get isConnected(): boolean {
      return false;
    },
  };
}

function insertTask(db: DatabaseSync, id: string, overrides: string | null = null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, status, task_size, task_number, settings_overrides, created_at, updated_at
    ) VALUES (?, ?, ?, 'in_progress', 'small', ?, ?, ?, ?)`
  ).run(id, `Task ${id}`, "Task description", `#${id}`, overrides, now, now);
}

describe("tasks read perf metrics", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl = "";
  let taskId = "";
  let logPath = "";

  beforeEach(async () => {
    resetAllMetrics();
    db = createDb();
    taskId = `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    insertTask(db, taskId, JSON.stringify({ review_mode: "pr_only" }));

    const app = express();
    app.use(express.json());
    app.use(createTasksRouter({
      db,
      ws: { broadcast() {} } as never,
      cache: createCache(),
    }));

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    logPath = join("data", "logs", `${taskId}.log`);
  });

  afterEach(async () => {
    clearPendingInteractivePrompt(taskId);
    rmSync(logPath, { force: true });
    db.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("records latency and payload for /tasks on cache miss and hit", async () => {
    const first = await fetch(`${baseUrl}/tasks`);
    assert.equal(first.status, 200);
    const firstBody = await first.text();

    const second = await fetch(`${baseUrl}/tasks`);
    assert.equal(second.status, 200);
    const secondBody = await second.text();

    const stats = metrics.readApi["/tasks"];
    assert.ok(stats, "expected /tasks metrics");
    assert.equal(stats.count, 2);
    assert.equal(stats.totalBytes, Buffer.byteLength(firstBody) + Buffer.byteLength(secondBody));
    assert.ok(stats.maxBytes >= Buffer.byteLength(firstBody));
  });

  it("records latency and payload for /tasks/:id/logs", async () => {
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
    ).run(taskId, "hello from stdout", Date.now());

    const response = await fetch(`${baseUrl}/tasks/${taskId}/logs`);
    assert.equal(response.status, 200);
    const body = await response.text();

    const stats = metrics.readApi["/tasks/:id/logs"];
    assert.ok(stats, "expected /tasks/:id/logs metrics");
    assert.equal(stats.count, 1);
    assert.equal(stats.totalBytes, Buffer.byteLength(body));
  });

  it("records latency and payload for /tasks/interactive-prompts", async () => {
    db.prepare(
      "UPDATE tasks SET interactive_prompt_data = ? WHERE id = ?"
    ).run(JSON.stringify({
      data: {
        promptType: "exit_plan_mode",
        message: "Need approval",
      },
      createdAt: Date.now(),
    }), taskId);
    restorePendingInteractivePrompts(db);

    const response = await fetch(`${baseUrl}/tasks/interactive-prompts`);
    assert.equal(response.status, 200);
    const body = await response.text();

    const stats = metrics.readApi["/tasks/interactive-prompts"];
    assert.ok(stats, "expected /tasks/interactive-prompts metrics");
    assert.equal(stats.count, 1);
    assert.equal(stats.totalBytes, Buffer.byteLength(body));
  });

  it("records latency and payload for /tasks/:id/settings", async () => {
    const response = await fetch(`${baseUrl}/tasks/${taskId}/settings`);
    assert.equal(response.status, 200);
    const body = await response.text();

    const stats = metrics.readApi["/tasks/:id/settings"];
    assert.ok(stats, "expected /tasks/:id/settings metrics");
    assert.equal(stats.count, 1);
    assert.equal(stats.totalBytes, Buffer.byteLength(body));
  });
});

describe("tasks/:id/logs incremental (since_id)", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl = "";
  let taskId = "";

  beforeEach(async () => {
    resetAllMetrics();
    db = createDb();
    taskId = `task-incr-${Date.now()}`;
    insertTask(db, taskId);

    const app = express();
    app.use(express.json());
    app.use(createTasksRouter({
      db,
      ws: { broadcast() {} } as never,
      cache: createCache(),
    }));

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server address unavailable");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    clearPendingInteractivePrompt(taskId);
    db.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("returns only rows with id > since_id in ASC order", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
      ).run(taskId, `line-${i}`, now + i);
    }

    const allRes = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100`);
    const allLogs = await allRes.json() as Array<{ id: number; message: string }>;
    assert.equal(allLogs.length, 5);

    const sinceId = allLogs[2]!.id;
    const incrRes = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100&since_id=${sinceId}`);
    const incrLogs = await incrRes.json() as Array<{ id: number; message: string }>;

    assert.ok(incrLogs.length > 0);
    for (const log of incrLogs) {
      assert.ok(log.id > sinceId, `expected id ${log.id} > since_id ${sinceId}`);
    }
    for (let i = 1; i < incrLogs.length; i++) {
      assert.ok(incrLogs[i]!.id > incrLogs[i - 1]!.id, "expected ASC order");
    }
  });

  it("does not include stage transition fold-in on incremental fetch", async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'system', ?, 'refinement', ?)"
    ).run(taskId, "__STAGE_TRANSITION__:inbox→refinement", now);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'stdout', ?, 'refinement', ?)"
    ).run(taskId, "work-line", now + 1);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'system', ?, 'in_progress', ?)"
    ).run(taskId, "__STAGE_TRANSITION__:refinement→in_progress", now + 2);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'stdout', ?, 'in_progress', ?)"
    ).run(taskId, "more-work", now + 3);

    const allLogs = await (await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100`)).json() as Array<{ id: number; message: string }>;
    const transitionLog = allLogs.find((l) => l.message.includes("inbox→refinement"));
    assert.ok(transitionLog, "initial fetch should include all transitions via fold-in");

    const lastId = allLogs.find((l) => l.message === "more-work")!.id;
    const sinceId = lastId - 1;
    const incrLogs = await (await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100&since_id=${sinceId}`)).json() as Array<{ id: number; message: string }>;

    const oldTransition = incrLogs.find((l) => l.message.includes("inbox→refinement"));
    assert.equal(oldTransition, undefined, "incremental fetch should not fold-in old transitions");
  });

  it("returns empty array when no rows exist after since_id", async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
    ).run(taskId, "only-line", now);

    const allLogs = await (await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100`)).json() as Array<{ id: number }>;
    const maxId = allLogs[0]!.id;

    const incrRes = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100&since_id=${maxId}`);
    const incrLogs = await incrRes.json() as Array<{ id: number }>;
    assert.equal(incrLogs.length, 0);
  });

  it("respects limit on incremental fetch", async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
      ).run(taskId, `line-${i}`, now + i);
    }

    const allLogs = await (await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100`)).json() as Array<{ id: number }>;
    const minId = allLogs[allLogs.length - 1]!.id;

    const incrRes = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=3&since_id=${minId}`);
    const incrLogs = await incrRes.json() as Array<{ id: number }>;
    assert.equal(incrLogs.length, 3);
  });

  it("falls back to initial fetch for non-numeric since_id", async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
    ).run(taskId, "test-line", now);

    const res = await fetch(`${baseUrl}/tasks/${taskId}/logs?since_id=abc`);
    const logs = await res.json() as Array<{ id: number; message: string }>;
    assert.equal(res.status, 200);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.message, "test-line");
  });

  it("returns since_id results in ASC order vs initial fetch in DESC order", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
      ).run(taskId, `line-${i}`, now + i);
    }

    const initRes = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100`);
    const initLogs = await initRes.json() as Array<{ id: number }>;
    for (let i = 1; i < initLogs.length; i++) {
      assert.ok(initLogs[i]!.id < initLogs[i - 1]!.id, "initial fetch should be DESC");
    }

    const minId = initLogs[initLogs.length - 1]!.id;
    const incrRes = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100&since_id=${minId}`);
    const incrLogs = await incrRes.json() as Array<{ id: number }>;
    for (let i = 1; i < incrLogs.length; i++) {
      assert.ok(incrLogs[i]!.id > incrLogs[i - 1]!.id, "incremental fetch should be ASC");
    }
  });
});

describe("tasks/:id/logs initial fetch and fold-in", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl = "";
  let taskId = "";

  beforeEach(async () => {
    resetAllMetrics();
    db = createDb();
    taskId = `task-init-${Date.now()}`;
    insertTask(db, taskId);

    const app = express();
    app.use(express.json());
    app.use(createTasksRouter({
      db,
      ws: { broadcast() {} } as never,
      cache: createCache(),
    }));

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server address unavailable");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    clearPendingInteractivePrompt(taskId);
    db.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("folds stage transitions outside pagination window into response", async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'system', ?, 'refinement', ?)"
    ).run(taskId, "__STAGE_TRANSITION__:inbox→refinement", now);

    for (let i = 1; i <= 10; i++) {
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'stdout', ?, 'in_progress', ?)"
      ).run(taskId, `work-${i}`, now + i);
    }

    const res = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=5`);
    const logs = await res.json() as Array<{ id: number; message: string }>;

    const hasTransition = logs.some((l) => l.message.includes("__STAGE_TRANSITION__:inbox→refinement"));
    assert.ok(hasTransition, "stage transition should be folded in even outside pagination window");
    assert.equal(logs.length, 6, "5 regular logs + 1 folded-in transition");
  });

  it("does not duplicate transitions already within the pagination window", async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'system', ?, 'refinement', ?)"
    ).run(taskId, "__STAGE_TRANSITION__:inbox→refinement", now);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'stdout', ?, 'refinement', ?)"
    ).run(taskId, "work", now + 1);

    const res = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100`);
    const logs = await res.json() as Array<{ id: number; message: string }>;

    const transitions = logs.filter((l) => l.message.includes("__STAGE_TRANSITION__"));
    assert.equal(transitions.length, 1, "transition should not be duplicated when within window");
  });

  it("applies offset parameter on initial fetch", async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
      ).run(taskId, `line-${i}`, now + i);
    }

    const fullRes = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=100`);
    const fullLogs = await fullRes.json() as Array<{ id: number }>;

    const offsetRes = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=5&offset=3`);
    const offsetLogs = await offsetRes.json() as Array<{ id: number }>;

    assert.ok(offsetLogs.length > 0);
    assert.equal(offsetLogs[0]?.id, fullLogs[3]!.id, "offset=3 should skip the 3 newest logs");
  });

  it("folds transitions even when offset pushes them out of the window", async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'system', ?, 'refinement', ?)"
    ).run(taskId, "__STAGE_TRANSITION__:inbox→refinement", now);

    for (let i = 1; i <= 8; i++) {
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message, stage, created_at) VALUES (?, 'stdout', ?, 'in_progress', ?)"
      ).run(taskId, `work-${i}`, now + i);
    }

    const res = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=3&offset=5`);
    const logs = await res.json() as Array<{ id: number; message: string }>;

    const hasTransition = logs.some((l) => l.message.includes("__STAGE_TRANSITION__"));
    assert.ok(hasTransition, "transitions should be folded in regardless of offset");
  });
});

describe("tasks/:id/logs message truncation", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl = "";
  let taskId = "";

  beforeEach(async () => {
    resetAllMetrics();
    db = createDb();
    taskId = `task-trunc-${Date.now()}`;
    insertTask(db, taskId);

    const app = express();
    app.use(express.json());
    app.use(createTasksRouter({
      db,
      ws: { broadcast() {} } as never,
      cache: createCache(),
    }));

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server address unavailable");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    clearPendingInteractivePrompt(taskId);
    db.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("truncates messages exceeding 4000 characters", async () => {
    const longMessage = "x".repeat(5000);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
    ).run(taskId, longMessage, Date.now());

    const res = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=10`);
    const logs = await res.json() as Array<{ message: string }>;

    assert.equal(logs.length, 1);
    assert.ok(logs[0]!.message.length < longMessage.length);
    assert.ok(logs[0]!.message.startsWith("x".repeat(100)));
    assert.match(logs[0]!.message, /\.\.\. \[truncated 1000 bytes\]$/);
  });

  it("preserves messages within 4000 characters", async () => {
    const shortMessage = "y".repeat(3999);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
    ).run(taskId, shortMessage, Date.now());

    const res = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=10`);
    const logs = await res.json() as Array<{ message: string }>;

    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.message, shortMessage);
  });

  it("preserves exactly 4000-char boundary message", async () => {
    const boundaryMessage = "b".repeat(4000);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
    ).run(taskId, boundaryMessage, Date.now());

    const res = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=10`);
    const logs = await res.json() as Array<{ message: string }>;

    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.message, boundaryMessage);
  });

  it("truncates on incremental fetch as well", async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
    ).run(taskId, "short", now);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'stdout', ?, ?)"
    ).run(taskId, "z".repeat(6000), now + 1);

    const initLogs = await (await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=10`)).json() as Array<{ id: number }>;
    const firstId = initLogs[initLogs.length - 1]!.id;

    const incrRes = await fetch(`${baseUrl}/tasks/${taskId}/logs?limit=10&since_id=${firstId}`);
    const incrLogs = await incrRes.json() as Array<{ message: string }>;

    const truncated = incrLogs.find((l) => l.message.includes("[truncated"));
    assert.ok(truncated, "should truncate on incremental fetch too");
    assert.match(truncated!.message, /\.\.\. \[truncated 2000 bytes\]$/);
  });
});
