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
});
