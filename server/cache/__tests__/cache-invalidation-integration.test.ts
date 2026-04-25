import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import type { CacheService } from "../cache-service.js";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "ao-cache-inv-")), "agent-organizer.db");

function createInMemoryCache(): CacheService & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown, _ttlSeconds: number): Promise<void> {
      store.set(key, value);
    },
    async del(keyOrKeys: string | string[]): Promise<void> {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      for (const k of keys) store.delete(k);
    },
    async invalidatePattern(pattern: string): Promise<void> {
      const prefix = pattern.replace("*", "");
      for (const k of [...store.keys()]) {
        if (k.startsWith(prefix)) store.delete(k);
      }
    },
    get isConnected() {
      return true;
    },
  };
}

function createWs() {
  return { broadcast() {} };
}

async function setupServer(): Promise<{
  db: DatabaseSync;
  server: Server;
  baseUrl: string;
  cache: ReturnType<typeof createInMemoryCache>;
}> {
  const { initializeDb } = await import("../../db/runtime.js");
  const { createTasksRouter } = await import("../../routes/tasks.js");
  const db = initializeDb();
  const cache = createInMemoryCache();

  const app = express();
  app.use(express.json());
  app.use(
    createTasksRouter(
      { db, ws: createWs() as never, cache: cache as never },
      { spawnAgent: async () => ({ pid: 0 }) as never },
    ),
  );

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server address unavailable");
  }

  return { db, server, baseUrl: `http://127.0.0.1:${address.port}`, cache };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("PUT /tasks/:id — targeted cache invalidation on status change", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl: string;
  let cache: ReturnType<typeof createInMemoryCache>;

  beforeEach(async () => {
    ({ db, server, baseUrl, cache } = await setupServer());
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("invalidates only old/new status caches and tasks:all, preserving unrelated caches", async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'inbox', 'small', ?, ?, ?)`,
    ).run("task-cache-1", "Cache test task", "#100", now, now);

    cache.store.set("tasks:all", [{ id: "task-cache-1" }]);
    cache.store.set("tasks:status:inbox", [{ id: "task-cache-1" }]);
    cache.store.set("tasks:status:in_progress", []);
    cache.store.set("tasks:status:done", [{ id: "other-done" }]);
    cache.store.set("agents:all", [{ id: "agent-1" }]);

    const response = await fetch(`${baseUrl}/tasks/task-cache-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });

    assert.equal(response.status, 200);

    assert.equal(cache.store.has("tasks:all"), false, "tasks:all should be invalidated");
    assert.equal(cache.store.has("tasks:status:inbox"), false, "old status cache should be invalidated");
    assert.equal(cache.store.has("tasks:status:in_progress"), false, "new status cache should be invalidated");
    assert.equal(cache.store.has("tasks:status:done"), true, "unrelated status cache should be preserved");
    assert.deepEqual(cache.store.get("tasks:status:done"), [{ id: "other-done" }]);
    assert.equal(cache.store.has("agents:all"), true, "agents:all should be preserved on non-agent change");
  });

  it("invalidates tasks:all + per-status cache when metadata changes without status change", async () => {
    // GET /tasks?status=X returns full SELECT * rows, so per-status cache
    // contains content fields (title, settings_overrides, refinement_plan etc).
    // Status-preserving content updates must invalidate the matching
    // tasks:status:{X} cache as well, otherwise stale rows leak through.
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'inbox', 'small', ?, ?, ?)`,
    ).run("task-cache-2", "Metadata test", "#101", now, now);

    cache.store.set("tasks:all", [{ id: "task-cache-2" }]);
    cache.store.set("tasks:status:inbox", [{ id: "task-cache-2", title: "Metadata test" }]);
    cache.store.set("tasks:status:done", [{ id: "other" }]);

    const response = await fetch(`${baseUrl}/tasks/task-cache-2`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated title" }),
    });

    assert.equal(response.status, 200);

    assert.equal(cache.store.has("tasks:all"), false, "tasks:all should be invalidated");
    assert.equal(
      cache.store.has("tasks:status:inbox"),
      false,
      "per-status cache must be invalidated because content fields are part of the cached rows",
    );
    assert.equal(cache.store.has("tasks:status:done"), true, "unrelated status cache should be preserved");
    assert.deepEqual(cache.store.get("tasks:status:done"), [{ id: "other" }]);
  });
});
