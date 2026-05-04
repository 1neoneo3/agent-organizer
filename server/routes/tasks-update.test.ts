import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import express from "express";
import type { DatabaseSync } from "node:sqlite";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "ao-update-")), "agent-organizer.db");

function createWs() {
  return {
    broadcast() {},
  };
}

async function setupServer(): Promise<{
  db: DatabaseSync;
  server: Server;
  baseUrl: string;
}> {
  const { initializeDb } = await import("../db/runtime.js");
  const { createTasksRouter } = await import("./tasks.js");
  const db = initializeDb();

  const app = express();
  app.use(express.json());
  app.use(
    createTasksRouter(
      { db, ws: createWs() as never },
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

  return { db, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("PUT /tasks/:id — title validation regressions", () => {
  it("rejects UUID-like title 'Task <uuid>' on update", async () => {
    const { db, server, baseUrl } = await setupServer();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'inbox', 'small', ?, ?, ?)`,
    ).run("task-update-1", "Original title", "#10", now, now);

    try {
      const response = await fetch(`${baseUrl}/tasks/task-update-1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Task 08209865-1234-5678-9abc-def012345678",
        }),
      });

      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "invalid_title");

      const row = db.prepare("SELECT title FROM tasks WHERE id = ?").get("task-update-1") as {
        title: string;
      };
      assert.equal(row.title, "Original title");
    } finally {
      await closeServer(server);
    }
  });

  it("logs a repository warning when updated project_path cannot auto-detect repository_url", async () => {
    const { db, server, baseUrl } = await setupServer();
    const now = Date.now();
    const projectPath = mkdtempSync(join(tmpdir(), "ao-update-non-git-"));
    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'inbox', 'small', ?, ?, ?)`,
    ).run("task-update-warning", "Original title", "#11", now, now);

    try {
      const response = await fetch(`${baseUrl}/tasks/task-update-warning`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_path: projectPath }),
      });

      assert.equal(response.status, 200);
      const log = db.prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE '[Repository Warning]%' ORDER BY id DESC LIMIT 1",
      ).get("task-update-warning") as { message: string } | undefined;
      assert.match(log?.message ?? "", /repository_url could not be auto-detected/);
      assert.match(log?.message ?? "", new RegExp(projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      await closeServer(server);
    }
  });
});
