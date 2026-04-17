import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { resolveStageAgentOverride, type StageSettingKey } from "./stage-agent-resolver.js";

/**
 * In-memory SQLite fixture with the minimal `agents` + `settings`
 * schema needed by the resolver. Kept local to this test file because
 * the production schema lives in server/db/schema.ts and is heavier
 * than what we need to exercise the override logic.
 */
function createFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'worker',
      status TEXT NOT NULL DEFAULT 'idle',
      role TEXT
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
    name?: string;
    agent_type?: "worker" | "ceo";
    status?: "idle" | "working" | "offline";
    role?: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO agents (id, name, agent_type, status, role) VALUES (?, ?, ?, ?, ?)",
  ).run(
    agent.id,
    agent.name ?? `agent-${agent.id}`,
    agent.agent_type ?? "worker",
    agent.status ?? "idle",
    agent.role ?? null,
  );
}

function setSetting(db: DatabaseSync, key: StageSettingKey, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

describe("resolveStageAgentOverride", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createFixture();
  });

  it("returns undefined when the setting is missing", () => {
    insertAgent(db, { id: "a1" });
    assert.equal(resolveStageAgentOverride(db, "review_agent_id"), undefined);
  });

  it("returns undefined when the setting is an empty string", () => {
    setSetting(db, "review_agent_id", "");
    insertAgent(db, { id: "a1" });
    assert.equal(resolveStageAgentOverride(db, "review_agent_id"), undefined);
  });

  it("returns undefined when the setting is whitespace", () => {
    setSetting(db, "review_agent_id", "   ");
    insertAgent(db, { id: "a1" });
    assert.equal(resolveStageAgentOverride(db, "review_agent_id"), undefined);
  });

  it("returns the agent when it is idle, worker, and not excluded", () => {
    insertAgent(db, { id: "reviewer-1", role: "code_reviewer" });
    setSetting(db, "review_agent_id", "reviewer-1");
    const result = resolveStageAgentOverride(db, "review_agent_id", ["implementer-1"]);
    assert.ok(result);
    assert.equal(result?.id, "reviewer-1");
  });

  it("returns undefined when the agent is busy (status=working)", () => {
    insertAgent(db, { id: "busy-reviewer", status: "working" });
    setSetting(db, "review_agent_id", "busy-reviewer");
    assert.equal(resolveStageAgentOverride(db, "review_agent_id"), undefined);
  });

  it("returns undefined when the agent is offline", () => {
    insertAgent(db, { id: "offline-reviewer", status: "offline" });
    setSetting(db, "review_agent_id", "offline-reviewer");
    assert.equal(resolveStageAgentOverride(db, "review_agent_id"), undefined);
  });

  it("returns undefined when the agent_id is in the exclude list (implementer)", () => {
    insertAgent(db, { id: "shared-agent" });
    setSetting(db, "review_agent_id", "shared-agent");
    assert.equal(
      resolveStageAgentOverride(db, "review_agent_id", ["shared-agent"]),
      undefined,
    );
  });

  it("skips null/undefined entries in the exclude list without throwing", () => {
    insertAgent(db, { id: "reviewer-1" });
    setSetting(db, "review_agent_id", "reviewer-1");
    const result = resolveStageAgentOverride(db, "review_agent_id", [null, undefined, ""]);
    assert.equal(result?.id, "reviewer-1");
  });

  it("returns undefined when the referenced agent does not exist", () => {
    setSetting(db, "review_agent_id", "ghost-agent");
    assert.equal(resolveStageAgentOverride(db, "review_agent_id"), undefined);
  });

  it("returns undefined for non-worker agents (e.g. ceo)", () => {
    insertAgent(db, { id: "ceo-1", agent_type: "ceo" });
    setSetting(db, "review_agent_id", "ceo-1");
    assert.equal(resolveStageAgentOverride(db, "review_agent_id"), undefined);
  });

  it("honours each stage setting key independently", () => {
    insertAgent(db, { id: "refiner", role: "code_reviewer" });
    insertAgent(db, { id: "qa", role: "tester" });
    setSetting(db, "refinement_agent_id", "refiner");
    setSetting(db, "qa_agent_id", "qa");

    assert.equal(resolveStageAgentOverride(db, "refinement_agent_id")?.id, "refiner");
    assert.equal(resolveStageAgentOverride(db, "qa_agent_id")?.id, "qa");
    assert.equal(resolveStageAgentOverride(db, "review_agent_id"), undefined);
    assert.equal(resolveStageAgentOverride(db, "test_generation_agent_id"), undefined);
    assert.equal(resolveStageAgentOverride(db, "ci_check_agent_id"), undefined);
  });
});
