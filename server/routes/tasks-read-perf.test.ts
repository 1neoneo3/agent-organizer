import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    async del(key: string): Promise<void> {
      store.delete(key);
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

  it("records latency and payload for /tasks/:id/terminal", async () => {
    mkdirSync(join("data", "logs"), { recursive: true });
    writeFileSync(logPath, "stdout line 1\nstdout line 2\n", "utf8");
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'system', ?, ?)"
    ).run(taskId, "system note", Date.now());

    const response = await fetch(`${baseUrl}/tasks/${taskId}/terminal`);
    assert.equal(response.status, 200);
    const body = await response.text();

    const stats = metrics.readApi["/tasks/:id/terminal"];
    assert.ok(stats, "expected /tasks/:id/terminal metrics");
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
