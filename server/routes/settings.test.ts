import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { initializeDb } from "../db/runtime.js";
import { createSettingsRouter } from "./settings.js";

function createWs() {
  return {
    broadcast() {},
  };
}

async function startServer(db: DatabaseSync): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use(createSettingsRouter({ db, ws: createWs() as never }));

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

function insertAgent(
  db: DatabaseSync,
  overrides: {
    id: string;
    role?: string | null;
    status?: "idle" | "working" | "offline";
    current_task_id?: string | null;
    agent_type?: "worker" | "ceo";
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (
      id, name, cli_provider, role, agent_type, status, current_task_id, created_at, updated_at
    ) VALUES (?, ?, 'codex', ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id,
    `Agent ${overrides.id}`,
    overrides.role ?? "lead_engineer",
    overrides.agent_type ?? "worker",
    overrides.status ?? "idle",
    overrides.current_task_id ?? null,
    now,
    now,
  );
}

async function putSettings(baseUrl: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /settings in_progress_agent_id validation", () => {
  it("allows saving a busy implementer because runtime availability is checked later", async () => {
    const db = initializeDb(":memory:");
    insertAgent(db, {
      id: "busy-impl",
      role: "lead_engineer",
      status: "working",
      current_task_id: "other-task",
    });
    const { server, baseUrl } = await startServer(db);

    try {
      const response = await putSettings(baseUrl, {
        in_progress_agent_id: "busy-impl",
        output_language: "en",
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, string>;
      assert.equal(body.in_progress_agent_id, "busy-impl");
      assert.equal(body.output_language, "en");
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("allows an unchanged stale saved value so full Settings PUT can still update other keys", async () => {
    const db = initializeDb(":memory:");
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('in_progress_agent_id', 'deleted-agent')")
      .run();
    const { server, baseUrl } = await startServer(db);

    try {
      const response = await putSettings(baseUrl, {
        in_progress_agent_id: "deleted-agent",
        output_language: "en",
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, string>;
      assert.equal(body.in_progress_agent_id, "deleted-agent");
      assert.equal(body.output_language, "en");
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("rejects a newly selected non-implementer agent", async () => {
    const db = initializeDb(":memory:");
    insertAgent(db, { id: "reviewer", role: "code_reviewer" });
    const { server, baseUrl } = await startServer(db);

    try {
      const response = await putSettings(baseUrl, {
        in_progress_agent_id: "reviewer",
      });

      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string; key: string };
      assert.equal(body.error, "invalid_in_progress_agent_id");
      assert.equal(body.key, "in_progress_agent_id");
    } finally {
      await closeServer(server);
      db.close();
    }
  });
});
