import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../db/schema.js";
import { createTasksRouter } from "./tasks.js";
import type { CacheService } from "../cache/cache-service.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function createCache(): CacheService {
  return {
    async get() {
      return null;
    },
    async set() {},
    async del() {},
    async invalidatePattern() {},
    get isConnected() {
      return false;
    },
  };
}

function insertTask(db: DatabaseSync, id: string, taskNumber: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, 'inbox', 'small', ?, ?, ?)`
  ).run(id, `Task ${id}`, "Delete route regression", taskNumber, createdAt, createdAt);
}

describe("DELETE /tasks/:id", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    db = createDb();
    const now = Date.now();
    insertTask(db, "task-1", "#1", now);
    insertTask(db, "task-2", "#2", now + 1);
    insertTask(db, "task-3", "#3", now + 2);

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
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("recompacts task numbers after deletion", async () => {
    const response = await fetch(`${baseUrl}/tasks/task-2`, { method: "DELETE" });
    assert.equal(response.status, 200);

    const tasks = (db.prepare(
      "SELECT id, task_number FROM tasks ORDER BY CAST(SUBSTR(task_number, 2) AS INTEGER) ASC",
    ).all() as Array<{ id: string; task_number: string }>).map((task) => ({
      id: task.id,
      task_number: task.task_number,
    }));

    assert.deepEqual(tasks, [
      { id: "task-1", task_number: "#1" },
      { id: "task-3", task_number: "#2" },
    ]);
  });
});
