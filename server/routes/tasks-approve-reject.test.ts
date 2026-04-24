import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { before, after, afterEach, describe, it } from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CacheService } from "../cache/cache-service.js";

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), "ao-approve-reject-"));
const TEST_DB_PATH = join(TEST_DB_DIR, "test.db");
process.env.DB_PATH = TEST_DB_PATH;

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

function createWsRecorder() {
  const events: Array<{ type: string; payload: unknown; options?: unknown }> = [];
  return {
    ws: {
      broadcast(type: string, payload: unknown, options?: unknown) {
        events.push({ type, payload, options });
      },
    },
    events,
  };
}

async function createDb(): Promise<DatabaseSync> {
  const mod = await import("../db/runtime.js");
  try {
    const prev = mod.getDb();
    prev.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    prev.close();
  } catch { /* no prior connection */ }
  rmSync(TEST_DB_PATH, { force: true });
  rmSync(`${TEST_DB_PATH}-wal`, { force: true });
  rmSync(`${TEST_DB_PATH}-shm`, { force: true });
  return mod.initializeDb();
}

async function startServer(
  db: DatabaseSync,
  deps: Parameters<typeof import("./tasks.js").createTasksRouter>[1],
): Promise<{ server: Server; baseUrl: string; events: Array<{ type: string; payload: unknown; options?: unknown }> }> {
  const { createTasksRouter } = await import("./tasks.js");
  const { ws, events } = createWsRecorder();
  const app = express();
  app.use(express.json());
  app.use(createTasksRouter({ db, ws: ws as never, cache: createCache() }, deps));

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server address unavailable");
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}`, events };
}

function insertAgent(db: DatabaseSync, agentId: string, status: "idle" | "working"): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at)
     VALUES (?, ?, 'claude', ?, ?, ?)`,
  ).run(agentId, `Agent ${agentId}`, status, now, now);
}

let testTaskSeq = 8000;
function insertTask(db: DatabaseSync, taskId: string, agentId: string | null, status: string): void {
  const now = Date.now();
  const taskNumber = `#${++testTaskSeq}`;
  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, status, task_size, task_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, ?)`,
  ).run(taskId, "Test task", "desc", agentId, status, taskNumber, now, now);
}

function getTask(db: DatabaseSync, taskId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
}

function getAgent(db: DatabaseSync, agentId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Record<string, unknown> | undefined;
}

function getLogs(db: DatabaseSync, taskId: string): string[] {
  return (
    db.prepare("SELECT message FROM task_logs WHERE task_id = ? ORDER BY id ASC").all(taskId) as Array<{ message: string }>
  ).map((r) => r.message);
}

describe("POST /tasks/:id/approve and /reject — refinement regressions", () => {
  after(() => {
    rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  // --- approve ---

  it("approve returns 404 when task does not exist", async () => {
    const db = await createDb();
    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${randomUUID()}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 404);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("approve returns 400 when task is not in an approvable status", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "in_progress");

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "not_in_approvable_status");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("advances refinement task to in_progress on approval", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "refinement");
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('default_enable_refinement', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => ({ pid: 1 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { approved: boolean; next_status: string };
      assert.equal(body.approved, true);
      assert.equal(body.next_status, "in_progress");

      const task = getTask(db, taskId);
      assert.ok(task);
      assert.equal(task.status, "in_progress");

      const logs = getLogs(db, taskId);
      assert.ok(logs.some((l) => l.includes("Refinement plan") && l.includes("approved")));
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  // --- reject ---

  it("reject returns 404 when task does not exist", async () => {
    const db = await createDb();
    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${randomUUID()}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 404);
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("reject returns 400 when task is not in a rejectable status", async () => {
    const db = await createDb();
    const taskId = randomUUID();
    insertTask(db, taskId, null, "done");

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "not_in_approvable_status");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("rejects refinement task, returns it to inbox, and releases the agent", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "refinement");

    const { server, baseUrl, events } = await startServer(db, {
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Plan too vague" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { rejected: boolean; reason: string };
      assert.equal(body.rejected, true);
      assert.equal(body.reason, "Plan too vague");

      const task = getTask(db, taskId);
      assert.ok(task);
      assert.equal(task.status, "inbox");
      assert.equal(task.assigned_agent_id, null);

      const agent = getAgent(db, agentId);
      assert.ok(agent);
      assert.equal(agent.status, "idle");

      const logs = getLogs(db, taskId);
      assert.ok(logs.some((l) => l.includes("rejected") && l.includes("Plan too vague")));

      assert.ok(events.some((e) => e.type === "agent_status"));
      assert.ok(events.some((e) => e.type === "task_update"));
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("reject uses default reason when none is provided", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "refinement");

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { rejected: boolean; reason: string };
      assert.equal(body.reason, "Refinement plan rejected");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  // --- human_review approve/reject ---

  it("advances human_review task to done on approval", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "human_review");
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('default_enable_human_review', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { approved: boolean; next_status: string };
      assert.equal(body.approved, true);
      assert.equal(body.next_status, "done");

      const task = getTask(db, taskId);
      assert.ok(task);
      assert.equal(task.status, "done");

      const logs = getLogs(db, taskId);
      assert.ok(logs.some((l) => l.includes("Human review") && l.includes("approved")));
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("rejects human_review task and releases the agent", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "working");
    insertTask(db, taskId, agentId, "human_review");

    const { server, baseUrl, events } = await startServer(db, {
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Needs more unit tests" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { rejected: boolean; reason: string };
      assert.equal(body.rejected, true);
      assert.equal(body.reason, "Needs more unit tests");

      const task = getTask(db, taskId);
      assert.ok(task);
      assert.equal(task.status, "inbox");
      assert.equal(task.assigned_agent_id, null);

      const agent = getAgent(db, agentId);
      assert.ok(agent);
      assert.equal(agent.status, "idle");

      const logs = getLogs(db, taskId);
      assert.ok(logs.some((l) => l.includes("Human review") && l.includes("rejected")));

      assert.ok(events.some((e) => e.type === "agent_status"));
      assert.ok(events.some((e) => e.type === "task_update"));
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("reject human_review uses default reason when none is provided", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, taskId, agentId, "human_review");

    const { server, baseUrl } = await startServer(db, {
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { rejected: boolean; reason: string };
      assert.equal(body.reason, "Rejected by human reviewer");
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  // --- dependency blocking ---

  it("returns 409 when refinement approval is blocked by unfinished dependency", async () => {
    const db = await createDb();
    const agentId = randomUUID();
    const depTaskId = randomUUID();
    const taskId = randomUUID();
    insertAgent(db, agentId, "idle");
    insertTask(db, depTaskId, null, "in_progress");
    const depTask = getTask(db, depTaskId);
    const depTaskNumber = depTask!.task_number as string;

    insertTask(db, taskId, agentId, "refinement");
    db.prepare("UPDATE tasks SET depends_on = ? WHERE id = ?").run(
      JSON.stringify([depTaskNumber]),
      taskId,
    );
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('default_enable_refinement', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();

    const { server, baseUrl, events } = await startServer(db, {
      spawnAgent: async () => ({ pid: 0 }) as never,
    });
    try {
      const res = await fetch(`${baseUrl}/tasks/${taskId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error: string; returned_to: string };
      assert.equal(body.error, "blocked_by_dependencies");
      assert.equal(body.returned_to, "inbox");

      const task = getTask(db, taskId);
      assert.ok(task);
      assert.equal(task.status, "inbox");
      assert.equal(task.assigned_agent_id, null);

      const agent = getAgent(db, agentId);
      assert.ok(agent);
      assert.equal(agent.status, "idle");

      const logs = getLogs(db, taskId);
      assert.ok(logs.some((l) => l.includes("blocked") && l.includes("inbox")));

      assert.ok(events.some((e) => e.type === "task_update"));
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });
});
