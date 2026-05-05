import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import express from "express";
import type { DatabaseSync } from "node:sqlite";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "ao-directives-controller-")), "agent-organizer.db");

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
  const { createDirectivesRouter } = await import("./directives.js");
  const db = initializeDb();

  const app = express();
  app.use(express.json());
  app.use(createDirectivesRouter({ db, ws: createWs() as never }));

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

function setControllerMode(db: DatabaseSync, enabled: boolean): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('enable_controller_mode', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(enabled ? "true" : "false", Date.now());
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("directive controller API", () => {
  it("keeps controller mode opt-in on directive creation", async () => {
    const { server, baseUrl } = await setupServer();

    try {
      const normalResponse = await fetch(`${baseUrl}/directives`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Normal", content: "Normal directive" }),
      });
      assert.equal(normalResponse.status, 201);
      const normal = (await normalResponse.json()) as { controller_mode: number | null };
      assert.equal(normal.controller_mode, 0);

      const controllerResponse = await fetch(`${baseUrl}/directives`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Controller",
          content: "Controller directive",
          controller_mode: true,
          controller_stage: "implement",
        }),
      });
      assert.equal(controllerResponse.status, 201);
      const controller = (await controllerResponse.json()) as {
        controller_mode: number;
        controller_stage: string;
      };
      assert.equal(controller.controller_mode, 1);
      assert.equal(controller.controller_stage, "implement");
    } finally {
      await closeServer(server);
    }
  });

  it("creates staged children through the controller split endpoint", async () => {
    const { db, server, baseUrl } = await setupServer();
    setControllerMode(db, true);
    const now = Date.now();
    db.prepare(
      `INSERT INTO directives (id, title, content, status, created_at, updated_at)
       VALUES ('d-split', 'Split me', 'Split me', 'pending', ?, ?)`,
    ).run(now, now);

    try {
      const response = await fetch(`${baseUrl}/directives/d-split/controller/split`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          children: [
            {
              task_number: "T01",
              title: "Implement",
              controller_stage: "implement",
              write_scope: ["server/controller/orchestrator.ts"],
            },
            {
              task_number: "T02",
              title: "Verify",
              controller_stage: "verify",
              depends_on: ["T01"],
            },
          ],
        }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as {
        directive: { controller_mode: number; controller_stage: string };
        tasks: Array<{ task_number: string; controller_stage: string }>;
      };

      assert.equal(body.directive.controller_mode, 1);
      assert.equal(body.directive.controller_stage, "implement");
      assert.deepStrictEqual(
        body.tasks.map((task) => [task.task_number, task.controller_stage]),
        [
          ["T01", "implement"],
          ["T02", "verify"],
        ],
      );
    } finally {
      await closeServer(server);
    }
  });

  it("rejects controller split while controller mode is disabled", async () => {
    const { db, server, baseUrl } = await setupServer();
    setControllerMode(db, false);
    const now = Date.now();
    db.prepare(
      `INSERT INTO directives (id, title, content, status, created_at, updated_at)
       VALUES ('d-disabled', 'Split me', 'Split me', 'pending', ?, ?)`,
    ).run(now, now);

    try {
      const response = await fetch(`${baseUrl}/directives/d-disabled/controller/split`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          children: [{ task_number: "T01", title: "Implement", controller_stage: "implement" }],
        }),
      });
      assert.equal(response.status, 403);
      const count = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE directive_id = 'd-disabled'").get() as { n: number };
      assert.equal(count.n, 0);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects controller split for completed directives", async () => {
    const { db, server, baseUrl } = await setupServer();
    setControllerMode(db, true);
    const now = Date.now();
    db.prepare(
      `INSERT INTO directives (
         id, title, content, status, completed_at, created_at, updated_at
       ) VALUES ('d-completed', 'Done', 'Done', 'completed', ?, ?, ?)`,
    ).run(now, now, now);

    try {
      const response = await fetch(`${baseUrl}/directives/d-completed/controller/split`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          children: [{ task_number: "T01", title: "Implement", controller_stage: "implement" }],
        }),
      });
      assert.equal(response.status, 409);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "directive_completed");

      const directive = db.prepare("SELECT status, completed_at FROM directives WHERE id = 'd-completed'")
        .get() as { status: string; completed_at: number | null };
      assert.equal(directive.status, "completed");
      assert.equal(directive.completed_at, now);
      const count = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE directive_id = 'd-completed'").get() as { n: number };
      assert.equal(count.n, 0);
    } finally {
      await closeServer(server);
    }
  });

  it("advances stage only when safety conditions are met", async () => {
    const { db, server, baseUrl } = await setupServer();
    setControllerMode(db, true);
    const now = Date.now();
    db.prepare(
      `INSERT INTO directives (
         id, title, content, status, controller_mode, controller_stage, created_at, updated_at
       ) VALUES ('d-advance', 'Advance me', 'Advance me', 'active', 1, 'implement', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO tasks (
         id, title, status, directive_id, task_number, controller_stage, created_at, updated_at
       ) VALUES
         ('task-impl', 'Implement', 'inbox', 'd-advance', 'T01', 'implement', ?, ?),
         ('task-verify', 'Verify', 'inbox', 'd-advance', 'T02', 'verify', ?, ?)`,
    ).run(now, now, now, now);

    try {
      const blocked = await fetch(`${baseUrl}/directives/d-advance/advance-stage`, { method: "POST" });
      assert.equal(blocked.status, 409);
      const blockedBody = (await blocked.json()) as { blocked_reason: string };
      assert.match(blockedBody.blocked_reason, /unfinished tasks/);

      db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'task-impl'").run();
      const advanced = await fetch(`${baseUrl}/directives/d-advance/advance-stage`, { method: "POST" });
      assert.equal(advanced.status, 200);
      const advancedBody = (await advanced.json()) as { directive: { controller_stage: string } };
      assert.equal(advancedBody.directive.controller_stage, "verify");
    } finally {
      await closeServer(server);
    }
  });
});
