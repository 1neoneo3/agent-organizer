import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { initializeDb } from "../db/runtime.js";
import { createTasksRouter } from "./tasks.js";

function createWs() {
  return {
    broadcast() {},
  };
}

async function startServer(
  db: DatabaseSync,
  deps: Parameters<typeof createTasksRouter>[1],
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use(createTasksRouter({ db, ws: createWs() as never }, deps));

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server address unavailable");
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function insertSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function insertAgent(
  db: DatabaseSync,
  overrides: {
    id: string;
    role?: string | null;
    status?: "idle" | "working" | "offline";
    current_task_id?: string | null;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (
      id, name, cli_provider, role, agent_type, status, current_task_id, created_at, updated_at
    ) VALUES (?, ?, 'codex', ?, 'worker', ?, ?, ?, ?)`,
  ).run(
    overrides.id,
    `Agent ${overrides.id}`,
    overrides.role ?? "lead_engineer",
    overrides.status ?? "idle",
    overrides.current_task_id ?? null,
    now,
    now,
  );
}

function insertInboxTask(db: DatabaseSync, taskId: string, assignedAgentId: string | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, project_path, status, task_size, task_number,
      created_at, updated_at
    ) VALUES (?, 'Manual run assignment', 'Manual run assignment test', ?, '/tmp/project',
      'inbox', 'medium', '#701', ?, ?)`,
  ).run(taskId, assignedAgentId, now, now);
}

async function postRun(baseUrl: string, taskId: string, body?: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/tasks/${taskId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

describe("POST /tasks/:id/run in_progress implementer assignment", () => {
  it("uses configured in_progress_agent_id over the existing task assignment", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "in_progress_agent_id", "configured-impl");
    insertAgent(db, { id: "assigned-impl", role: "lead_engineer" });
    insertAgent(db, { id: "configured-impl", role: "architect" });
    insertInboxTask(db, "task-run-1", "assigned-impl");

    const spawned: Array<{ agentId: string; taskId: string }> = [];
    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async (_db, _ws, agent, task) => {
        spawned.push({ agentId: agent.id, taskId: task.id });
        return { pid: 123 } as never;
      },
    });

    try {
      const response = await postRun(baseUrl, "task-run-1");
      assert.equal(response.status, 200);
      const body = (await response.json()) as { started: boolean; pid: number };
      assert.deepEqual(body, { started: true, pid: 123 });

      const row = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get("task-run-1") as {
        assigned_agent_id: string | null;
      };
      assert.equal(row.assigned_agent_id, "configured-impl");
      assert.deepEqual(spawned, [{ agentId: "configured-impl", taskId: "task-run-1" }]);
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("lets an explicit manual agent_id override the configured in_progress_agent_id", async () => {
    const db = initializeDb(":memory:");
    insertSetting(db, "in_progress_agent_id", "configured-impl");
    insertAgent(db, { id: "configured-impl", role: "lead_engineer" });
    insertAgent(db, { id: "requested-impl", role: "architect" });
    insertInboxTask(db, "task-run-2", null);

    const spawned: Array<{ agentId: string; taskId: string }> = [];
    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async (_db, _ws, agent, task) => {
        spawned.push({ agentId: agent.id, taskId: task.id });
        return { pid: 456 } as never;
      },
    });

    try {
      const response = await postRun(baseUrl, "task-run-2", { agent_id: "requested-impl" });
      assert.equal(response.status, 200);

      const row = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get("task-run-2") as {
        assigned_agent_id: string | null;
      };
      assert.equal(row.assigned_agent_id, "requested-impl");
      assert.deepEqual(spawned, [{ agentId: "requested-impl", taskId: "task-run-2" }]);
    } finally {
      await closeServer(server);
      db.close();
    }
  });
});
