import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import http from "node:http";
import { SCHEMA_SQL } from "../db/schema.js";
import { createTasksRouter } from "./tasks.js";
import type { WsHub } from "../ws/hub.js";
import type { CacheService } from "../cache/cache-service.js";
import type { Task } from "../types/runtime.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function createFakeWs() {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const hub: WsHub = {
    clients: new Set(),
    addClient() {},
    removeClient() {},
    subscribeClientToTask() {},
    unsubscribeClientFromTask() {},
    broadcast(type: string, payload: unknown) {
      sent.push({ type, payload });
    },
    dispose() {},
  };
  return Object.assign(hub, { sent });
}

function createFakeCache(): CacheService {
  return {
    get: async () => null,
    set: async () => {},
    del: async () => {},
    invalidatePattern: async () => {},
    isConnected: false,
  };
}

function insertTask(db: DatabaseSync, overrides?: Partial<Task>): Task {
  const now = Date.now();
  const id = overrides?.id ?? "task-1";
  const status = overrides?.status ?? "refinement";

  db.prepare(
    `INSERT INTO tasks (id, title, status, priority, task_size, task_number, refinement_plan, refinement_completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides?.title ?? "Test Task",
    status,
    overrides?.priority ?? 5,
    overrides?.task_size ?? "small",
    overrides?.task_number ?? "#1",
    overrides?.refinement_plan ?? null,
    overrides?.refinement_completed_at ?? null,
    now,
    now,
  );

  return db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(id) as unknown as Task;
}

interface TestServer {
  baseUrl: string;
  server: http.Server;
  close: () => Promise<void>;
}

async function startTestServer(db: DatabaseSync, ws: WsHub, cache: CacheService): Promise<TestServer> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createTasksRouter({ db, ws, cache }));

  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function putRefinementPlan(
  baseUrl: string,
  taskId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/refinement-plan`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as unknown as Record<string, unknown> };
}

type TaskLike = Record<string, unknown>;

describe("PUT /tasks/:id/refinement-plan", () => {
  let db: DatabaseSync;
  let ws: ReturnType<typeof createFakeWs>;
  let cache: CacheService;
  let srv: TestServer;

  beforeEach(async () => {
    db = createDb();
    ws = createFakeWs();
    cache = createFakeCache();
    srv = await startTestServer(db, ws, cache);
  });

  afterEach(async () => {
    await srv.close();
    db.close();
  });

  it("updates refinement_plan for a task in 'refinement' status", async () => {
    insertTask(db, { id: "t1", status: "refinement" });

    const { status, body } = await putRefinementPlan(srv.baseUrl, "t1", {
      content: "---REFINEMENT PLAN---\nNew plan content\n---END REFINEMENT---",
      source: "file",
    });

    assert.equal(status, 200);
    assert.equal((body as TaskLike).refinement_plan, "---REFINEMENT PLAN---\nNew plan content\n---END REFINEMENT---");
    assert.ok((body as TaskLike).refinement_completed_at);

    const row = db.prepare("SELECT refinement_plan, refinement_completed_at FROM tasks WHERE id = ?").get("t1") as {
      refinement_plan: string;
      refinement_completed_at: number;
    };
    assert.equal(row.refinement_plan, "---REFINEMENT PLAN---\nNew plan content\n---END REFINEMENT---");
    assert.ok(row.refinement_completed_at > 0);
  });

  it("updates refinement_plan for a task in 'inbox' status", async () => {
    insertTask(db, { id: "t2", status: "inbox" });

    const { status } = await putRefinementPlan(srv.baseUrl, "t2", {
      content: "Plan for inbox task",
    });

    assert.equal(status, 200);
    const row = db.prepare("SELECT refinement_plan FROM tasks WHERE id = ?").get("t2") as { refinement_plan: string };
    assert.equal(row.refinement_plan, "Plan for inbox task");
  });

  it("defaults source to 'file' when omitted", async () => {
    insertTask(db, { id: "t3", status: "refinement" });

    const { status } = await putRefinementPlan(srv.baseUrl, "t3", {
      content: "Plan content",
    });

    assert.equal(status, 200);
    const log = db
      .prepare("SELECT message FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT 1")
      .get("t3") as { message: string };
    assert.equal(log.message, "[plan-sync] refinement_plan updated from file");
  });

  it("records source='agent_output' in task_log when specified", async () => {
    insertTask(db, { id: "t4", status: "refinement" });

    await putRefinementPlan(srv.baseUrl, "t4", {
      content: "Plan from agent",
      source: "agent_output",
    });

    const log = db
      .prepare("SELECT message FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT 1")
      .get("t4") as { message: string };
    assert.equal(log.message, "[plan-sync] refinement_plan updated from agent_output");
  });

  it("does not overwrite existing refinement_completed_at", async () => {
    const existingTimestamp = Date.now() - 60_000;
    insertTask(db, { id: "t5", status: "refinement", refinement_completed_at: existingTimestamp });

    const { status, body } = await putRefinementPlan(srv.baseUrl, "t5", {
      content: "Updated plan v2",
    });

    assert.equal(status, 200);
    assert.equal((body as TaskLike).refinement_completed_at, existingTimestamp);
  });

  it("sets refinement_completed_at when it was null", async () => {
    insertTask(db, { id: "t6", status: "refinement", refinement_completed_at: null });
    const before = Date.now();

    const { body } = await putRefinementPlan(srv.baseUrl, "t6", {
      content: "First plan",
    });

    const completedAt = (body as TaskLike).refinement_completed_at as number;
    assert.ok(completedAt >= before);
  });

  it("broadcasts task_update via WebSocket", async () => {
    insertTask(db, { id: "t7", status: "refinement" });
    ws.sent.length = 0;

    await putRefinementPlan(srv.baseUrl, "t7", { content: "WS test plan" });

    const taskUpdates = ws.sent.filter((m) => m.type === "task_update");
    assert.ok(taskUpdates.length > 0);
    assert.equal((taskUpdates[0].payload as TaskLike).id, "t7");
    assert.equal((taskUpdates[0].payload as TaskLike).refinement_plan, "WS test plan");
  });

  it("returns 404 for non-existent task", async () => {
    const { status, body } = await putRefinementPlan(srv.baseUrl, "nonexistent", {
      content: "Plan content",
    });

    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });

  it("returns 409 when task status is 'in_progress'", async () => {
    insertTask(db, { id: "t8", status: "in_progress" });

    const { status, body } = await putRefinementPlan(srv.baseUrl, "t8", {
      content: "Plan for in-progress task",
    });

    assert.equal(status, 409);
    assert.equal(body.error, "invalid_status");
    assert.ok((body.message as string).includes("in_progress"));
  });

  it("returns 409 when task status is 'done'", async () => {
    insertTask(db, { id: "t9", status: "done" });

    const { status, body } = await putRefinementPlan(srv.baseUrl, "t9", {
      content: "Plan for done task",
    });

    assert.equal(status, 409);
    assert.equal(body.error, "invalid_status");
  });

  it("returns 409 when task status is 'pr_review'", async () => {
    insertTask(db, { id: "t10", status: "pr_review" });

    const { status } = await putRefinementPlan(srv.baseUrl, "t10", {
      content: "Plan content",
    });

    assert.equal(status, 409);
  });

  it("returns 400 when content is empty", async () => {
    insertTask(db, { id: "t11", status: "refinement" });

    const { status } = await putRefinementPlan(srv.baseUrl, "t11", {
      content: "",
    });

    assert.equal(status, 400);
  });

  it("returns 400 when content is missing", async () => {
    insertTask(db, { id: "t12", status: "refinement" });

    const { status } = await putRefinementPlan(srv.baseUrl, "t12", {});

    assert.equal(status, 400);
  });

  it("returns 400 for invalid source value", async () => {
    insertTask(db, { id: "t13", status: "refinement" });

    const { status } = await putRefinementPlan(srv.baseUrl, "t13", {
      content: "Plan content",
      source: "invalid_source",
    });

    assert.equal(status, 400);
  });

  it("updates updated_at timestamp", async () => {
    insertTask(db, { id: "t14", status: "refinement" });
    const beforeUpdate = (db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get("t14") as { updated_at: number }).updated_at;

    await new Promise((r) => setTimeout(r, 10));
    await putRefinementPlan(srv.baseUrl, "t14", { content: "New plan" });

    const afterUpdate = (db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get("t14") as { updated_at: number }).updated_at;
    assert.ok(afterUpdate > beforeUpdate);
  });

  it("inserts a task_log entry with plan-sync kind", async () => {
    insertTask(db, { id: "t15", status: "refinement" });

    await putRefinementPlan(srv.baseUrl, "t15", { content: "Log test" });

    const logs = db
      .prepare("SELECT * FROM task_logs WHERE task_id = ? AND kind = 'system'")
      .all("t15") as Array<{ message: string }>;
    const syncLog = logs.find((l) => l.message.includes("[plan-sync]"));
    assert.ok(syncLog);
  });

  it("accepts large plan content up to 500KB", async () => {
    insertTask(db, { id: "t16", status: "refinement" });
    const largePlan = "x".repeat(499_000);

    const { status } = await putRefinementPlan(srv.baseUrl, "t16", {
      content: largePlan,
    });

    assert.equal(status, 200);
  });

  it("handles concurrent updates (last write wins)", async () => {
    insertTask(db, { id: "t17", status: "refinement" });

    const [res1, res2] = await Promise.all([
      putRefinementPlan(srv.baseUrl, "t17", { content: "Plan v1", source: "file" }),
      putRefinementPlan(srv.baseUrl, "t17", { content: "Plan v2", source: "agent_output" }),
    ]);

    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);

    const row = db.prepare("SELECT refinement_plan FROM tasks WHERE id = ?").get("t17") as { refinement_plan: string };
    assert.ok(row.refinement_plan === "Plan v1" || row.refinement_plan === "Plan v2");
  });
});
