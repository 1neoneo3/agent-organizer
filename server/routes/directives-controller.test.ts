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
              controller_role: "lead_engineer",
              write_scope: ["server/controller/orchestrator.ts"],
            },
            {
              task_number: "T02",
              title: "Verify",
              controller_stage: "verify",
              controller_role: "tester",
              depends_on: ["T01"],
            },
          ],
        }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as {
        directive: { controller_mode: number; controller_stage: string };
        tasks: Array<{ task_number: string; controller_stage: string; controller_role: string | null }>;
      };

      assert.equal(body.directive.controller_mode, 1);
      assert.equal(body.directive.controller_stage, "implement");
      assert.deepStrictEqual(
        body.tasks.map((task) => [task.task_number, task.controller_stage, task.controller_role]),
        [
          ["T01", "implement", "lead_engineer"],
          ["T02", "verify", "tester"],
        ],
      );
    } finally {
      await closeServer(server);
    }
  });
});
