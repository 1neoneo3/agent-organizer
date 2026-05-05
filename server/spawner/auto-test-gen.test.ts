import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { resolveTestGenAgent } from "./auto-test-gen.js";

/**
 * In-memory SQLite fixture covering only the columns the test-gen
 * selector touches. Mirrors `auto-qa.test.ts`'s selector fixture
 * because the two stages share the same selection contract.
 */
function createFixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'worker',
      status TEXT NOT NULL DEFAULT 'idle',
      current_task_id TEXT,
      role TEXT,
      cli_model TEXT
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function insertAgent(
  db: DatabaseSync,
  agent: {
    id: string;
    role?: string | null;
    cli_model?: string | null;
    status?: "idle" | "working" | "offline";
    current_task_id?: string | null;
    agent_type?: "worker" | "ceo";
  },
): void {
  db.prepare(
    "INSERT INTO agents (id, name, agent_type, status, current_task_id, role, cli_model) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    agent.id,
    agent.id,
    agent.agent_type ?? "worker",
    agent.status ?? "idle",
    agent.current_task_id ?? null,
    agent.role ?? null,
    agent.cli_model ?? null,
  );
}

function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

describe("resolveTestGenAgent", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createFixture();
  });

  it("returns the override match when test_generation_agent_role/model is configured and a worker matches", () => {
    insertAgent(db, { id: "tester", role: "tester", cli_model: "claude-haiku-4-5" });
    insertAgent(db, { id: "lead-1", role: "lead_engineer" });
    setSetting(db, "test_generation_agent_role", "tester");
    setSetting(db, "test_generation_agent_model", "claude-haiku-4-5");

    const result = resolveTestGenAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent?.id, "tester");
    }
  });

  it("strict mode: returns `skip` when override is configured but no idle worker matches", () => {
    insertAgent(db, { id: "lead-1", role: "lead_engineer" });
    setSetting(db, "test_generation_agent_role", "tester");

    const result = resolveTestGenAgent(db, "implementer-id");
    assert.equal(result.kind, "skip");
    if (result.kind === "skip") {
      assert.match(result.reason, /no matching idle worker/i);
    }
  });

  it("strict mode: returns `skip` when only the implementer would match (excluded)", () => {
    insertAgent(db, { id: "impl-as-tester", role: "tester" });
    setSetting(db, "test_generation_agent_role", "tester");

    const result = resolveTestGenAgent(db, "impl-as-tester");
    assert.equal(result.kind, "skip");
  });

  it("falls back to a tester role when override is unconfigured", () => {
    insertAgent(db, { id: "tester-1", role: "tester" });
    insertAgent(db, { id: "lead-1", role: "lead_engineer" });
    const result = resolveTestGenAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent?.id, "tester-1");
    }
  });

  it("falls back to any idle worker when neither override nor a tester role is registered", () => {
    insertAgent(db, { id: "lead-1", role: "lead_engineer" });
    const result = resolveTestGenAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent?.id, "lead-1");
    }
  });

  it("returns `agent: undefined` (no skip) when unconfigured and no idle worker exists", () => {
    insertAgent(db, { id: "lead-1", role: "lead_engineer", status: "working" });
    const result = resolveTestGenAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent, undefined);
    }
  });

  it("excludes stale current_task_id pointers from unconfigured fallback", () => {
    insertAgent(db, {
      id: "stale-tester",
      role: "tester",
      status: "idle",
      current_task_id: "stale-task",
    });
    insertAgent(db, { id: "lead-1", role: "lead_engineer" });
    const result = resolveTestGenAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent?.id, "lead-1");
    }
  });

  it("treats whitespace-only role/model settings as unconfigured", () => {
    insertAgent(db, { id: "tester-1", role: "tester" });
    setSetting(db, "test_generation_agent_role", "   ");
    setSetting(db, "test_generation_agent_model", "   ");
    const result = resolveTestGenAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent?.id, "tester-1");
    }
  });
});
