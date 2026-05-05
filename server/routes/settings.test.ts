import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import express from "express";

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
  const { createSettingsRouter } = await import("./settings.js");
  const dbPath = join(mkdtempSync(join(tmpdir(), "ao-settings-route-")), "agent-organizer.db");
  const db = initializeDb(dbPath);

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

  return { db, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function putSettings(baseUrl: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("settings API", () => {
  it("allows toggling controller mode on and off", async () => {
    const { db, server, baseUrl } = await setupServer();

    try {
      const enabled = await putSettings(baseUrl, { enable_controller_mode: "true" });
      assert.equal(enabled.status, 200);
      assert.equal(((await enabled.json()) as Record<string, string>).enable_controller_mode, "true");

      const disabled = await putSettings(baseUrl, { enable_controller_mode: "false" });
      assert.equal(disabled.status, 200);
      assert.equal(((await disabled.json()) as Record<string, string>).enable_controller_mode, "false");
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("rejects invalid controller mode values", async () => {
    const { db, server, baseUrl } = await setupServer();

    try {
      const response = await putSettings(baseUrl, { enable_controller_mode: "yes" });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "invalid_settings_values");
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("allows saving the full settings payload when workflow command keys already exist", async () => {
    const { db, server, baseUrl } = await setupServer();

    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("check_types_cmd", "npm run check");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("check_lint_cmd", "");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("refinement_as_pr", "false");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("human_review_count", "2");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("in_progress_agent_role", "lead_engineer");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("in_progress_agent_model", "claude-opus-4-6");

      const currentResponse = await fetch(`${baseUrl}/settings`);
      assert.equal(currentResponse.status, 200);
      const current = (await currentResponse.json()) as Record<string, string>;

      const response = await putSettings(baseUrl, {
        ...current,
        output_language: "en",
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, string>;
      assert.equal(body.output_language, "en");
      assert.equal(body.check_types_cmd, "npm run check");
      assert.equal(body.refinement_as_pr, "false");
      assert.equal(body.human_review_count, "2");
      assert.equal(body.in_progress_agent_role, "lead_engineer");
      assert.equal(body.in_progress_agent_model, "claude-opus-4-6");
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("still rejects unknown settings keys that are not already present", async () => {
    const { db, server, baseUrl } = await setupServer();

    try {
      const response = await putSettings(baseUrl, { typo_setting_key: "true" });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string; keys: string[] };
      assert.equal(body.error, "unknown_settings_keys");
      assert.deepEqual(body.keys, ["typo_setting_key"]);
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("filters the deprecated implementation pin from settings reads and writes", async () => {
    const { db, server, baseUrl } = await setupServer();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('in_progress_agent_id', 'deleted-agent')")
      .run();

    try {
      const currentResponse = await fetch(`${baseUrl}/settings`);
      assert.equal(currentResponse.status, 200);
      const currentBody = (await currentResponse.json()) as Record<string, string>;
      assert.equal(Object.prototype.hasOwnProperty.call(currentBody, "in_progress_agent_id"), false);

      const response = await putSettings(baseUrl, {
        in_progress_agent_id: "ignored-agent",
        output_language: "en",
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, string>;
      assert.equal(Object.prototype.hasOwnProperty.call(body, "in_progress_agent_id"), false);
      assert.equal(body.output_language, "en");
    } finally {
      await closeServer(server);
      db.close();
    }
  });
});
