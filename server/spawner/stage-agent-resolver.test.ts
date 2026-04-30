import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  resolveStageAgentOverride,
  resolveStageAgentSelection,
  type StageModelSettingKey,
  type StageSettingKey,
} from "./stage-agent-resolver.js";

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
    name?: string;
    agent_type?: "worker" | "ceo";
    status?: "idle" | "working" | "offline";
    current_task_id?: string | null;
    role?: string | null;
    cli_model?: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO agents (id, name, agent_type, status, current_task_id, role, cli_model) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    agent.id,
    agent.name ?? `agent-${agent.id}`,
    agent.agent_type ?? "worker",
    agent.status ?? "idle",
    agent.current_task_id ?? null,
    agent.role ?? null,
    agent.cli_model ?? null,
  );
}

function setSetting(db: DatabaseSync, key: StageSettingKey, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function setModelSetting(db: DatabaseSync, key: StageModelSettingKey, value: string): void {
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
    assert.equal(resolveStageAgentOverride(db, "review_agent_role", "review_agent_model"), undefined);
  });

  it("returns undefined when both filters are empty strings", () => {
    setSetting(db, "review_agent_role", "");
    setModelSetting(db, "review_agent_model", "");
    insertAgent(db, { id: "a1" });
    assert.equal(resolveStageAgentOverride(db, "review_agent_role", "review_agent_model"), undefined);
  });

  it("returns the agent when role matches and it is idle, worker, and not excluded", () => {
    insertAgent(db, { id: "reviewer-1", role: "code_reviewer", cli_model: "gpt-5.4" });
    setSetting(db, "review_agent_role", "code_reviewer");
    const result = resolveStageAgentOverride(db, "review_agent_role", "review_agent_model", ["implementer-1"]);
    assert.ok(result);
    assert.equal(result?.id, "reviewer-1");
  });

  it("returns the agent when only the model filter matches", () => {
    insertAgent(db, { id: "reviewer-1", role: "code_reviewer", cli_model: "gpt-5.4" });
    setModelSetting(db, "review_agent_model", "gpt-5.4");
    const result = resolveStageAgentOverride(db, "review_agent_role", "review_agent_model");
    assert.equal(result?.id, "reviewer-1");
  });

  it("requires both role and model when both filters are set", () => {
    insertAgent(db, { id: "reviewer-1", role: "code_reviewer", cli_model: "gpt-5.4" });
    insertAgent(db, { id: "reviewer-2", role: "code_reviewer", cli_model: "claude-opus-4-6" });
    setSetting(db, "review_agent_role", "code_reviewer");
    setModelSetting(db, "review_agent_model", "claude-opus-4-6");
    const result = resolveStageAgentOverride(db, "review_agent_role", "review_agent_model");
    assert.equal(result?.id, "reviewer-2");
  });

  it("returns undefined when only whitespace filters are present", () => {
    setSetting(db, "review_agent_role", "   ");
    setModelSetting(db, "review_agent_model", "   ");
    insertAgent(db, { id: "a1" });
    assert.equal(resolveStageAgentOverride(db, "review_agent_role", "review_agent_model"), undefined);
  });

  it("returns undefined when the agent is busy (status=working)", () => {
    insertAgent(db, { id: "busy-reviewer", status: "working", role: "code_reviewer" });
    setSetting(db, "review_agent_role", "code_reviewer");
    assert.equal(resolveStageAgentOverride(db, "review_agent_role", "review_agent_model"), undefined);
  });

  it("returns undefined when the agent is offline", () => {
    insertAgent(db, { id: "offline-reviewer", status: "offline", role: "code_reviewer" });
    setSetting(db, "review_agent_role", "code_reviewer");
    assert.equal(resolveStageAgentOverride(db, "review_agent_role", "review_agent_model"), undefined);
  });

  it("returns undefined when every matching agent is in the exclude list", () => {
    insertAgent(db, { id: "shared-agent", role: "code_reviewer", cli_model: "gpt-5.4" });
    setSetting(db, "review_agent_role", "code_reviewer");
    setModelSetting(db, "review_agent_model", "gpt-5.4");
    assert.equal(
      resolveStageAgentOverride(db, "review_agent_role", "review_agent_model", ["shared-agent"]),
      undefined,
    );
  });

  it("skips null/undefined entries in the exclude list without throwing", () => {
    insertAgent(db, { id: "reviewer-1", role: "code_reviewer" });
    setSetting(db, "review_agent_role", "code_reviewer");
    const result = resolveStageAgentOverride(db, "review_agent_role", "review_agent_model", [null, undefined, ""]);
    assert.equal(result?.id, "reviewer-1");
  });

  it("returns undefined when no idle worker matches the configured role/model", () => {
    insertAgent(db, { id: "reviewer-1", role: "code_reviewer", cli_model: "gpt-5.4" });
    setSetting(db, "review_agent_role", "tester");
    setModelSetting(db, "review_agent_model", "claude-opus-4-6");
    assert.equal(resolveStageAgentOverride(db, "review_agent_role", "review_agent_model"), undefined);
  });

  it("returns undefined for non-worker agents (e.g. ceo)", () => {
    insertAgent(db, { id: "ceo-1", agent_type: "ceo", role: "code_reviewer" });
    setSetting(db, "review_agent_role", "code_reviewer");
    assert.equal(resolveStageAgentOverride(db, "review_agent_role", "review_agent_model"), undefined);
  });

  it("honours each stage setting key independently", () => {
    insertAgent(db, { id: "refiner", role: "planner", cli_model: "claude-opus-4-6" });
    insertAgent(db, { id: "qa", role: "tester", cli_model: "gpt-5.4" });
    setSetting(db, "refinement_agent_role", "planner");
    setModelSetting(db, "refinement_agent_model", "claude-opus-4-6");
    setSetting(db, "qa_agent_role", "tester");
    setModelSetting(db, "qa_agent_model", "gpt-5.4");

    assert.equal(resolveStageAgentOverride(db, "refinement_agent_role", "refinement_agent_model")?.id, "refiner");
    assert.equal(resolveStageAgentOverride(db, "qa_agent_role", "qa_agent_model")?.id, "qa");
    assert.equal(resolveStageAgentOverride(db, "review_agent_role", "review_agent_model"), undefined);
    assert.equal(resolveStageAgentOverride(db, "test_generation_agent_role", "test_generation_agent_model"), undefined);
  });
});

describe("resolveStageAgentSelection", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createFixture();
  });

  it("returns `unconfigured` when both filters are missing", () => {
    insertAgent(db, { id: "a1", role: "code_reviewer" });
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model");
    assert.equal(result.status, "unconfigured");
  });

  it("returns `unconfigured` when both filter values are whitespace-only", () => {
    setSetting(db, "review_agent_role", "  ");
    setModelSetting(db, "review_agent_model", "  ");
    insertAgent(db, { id: "a1", role: "code_reviewer" });
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model");
    assert.equal(result.status, "unconfigured");
  });

  it("returns `configured_match` when an idle worker satisfies the filters", () => {
    insertAgent(db, { id: "reviewer", role: "code_reviewer", cli_model: "gpt-5.4" });
    setSetting(db, "review_agent_role", "code_reviewer");
    setModelSetting(db, "review_agent_model", "gpt-5.4");
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model");
    assert.equal(result.status, "configured_match");
    if (result.status === "configured_match") {
      assert.equal(result.agent.id, "reviewer");
    }
  });

  it("returns `configured_no_match` when filters are set but no idle worker matches", () => {
    insertAgent(db, { id: "reviewer", role: "code_reviewer", cli_model: "gpt-5.4" });
    setSetting(db, "review_agent_role", "tester"); // No tester registered.
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model");
    assert.equal(result.status, "configured_no_match");
  });

  it("returns `configured_no_match` when the only matching worker is busy", () => {
    insertAgent(db, {
      id: "busy-reviewer",
      role: "code_reviewer",
      status: "working",
    });
    setSetting(db, "review_agent_role", "code_reviewer");
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model");
    assert.equal(result.status, "configured_no_match");
  });

  it("returns `configured_no_match` when the only matching idle worker has a stale current_task_id", () => {
    insertAgent(db, {
      id: "stale-reviewer",
      role: "code_reviewer",
      status: "idle",
      current_task_id: "stale-task",
    });
    setSetting(db, "review_agent_role", "code_reviewer");
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model");
    assert.equal(result.status, "configured_no_match");
  });

  it("returns `configured_no_match` when the only matching worker is excluded", () => {
    insertAgent(db, { id: "excluded", role: "code_reviewer" });
    setSetting(db, "review_agent_role", "code_reviewer");
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model", {
      excludeIds: ["excluded"],
    });
    assert.equal(result.status, "configured_no_match");
  });

  it("returns `configured_no_match` when only a non-worker (ceo) matches", () => {
    insertAgent(db, { id: "ceo-1", role: "code_reviewer", agent_type: "ceo" });
    setSetting(db, "review_agent_role", "code_reviewer");
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model");
    assert.equal(result.status, "configured_no_match");
  });

  it("returns `configured_no_match_in_pool` when matching workers exist but none are in the candidate pool", () => {
    insertAgent(db, { id: "match-1", role: "code_reviewer" });
    insertAgent(db, { id: "match-2", role: "code_reviewer" });
    setSetting(db, "review_agent_role", "code_reviewer");
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model", {
      candidatePool: new Set(["unrelated-1"]),
    });
    assert.equal(result.status, "configured_no_match_in_pool");
    if (result.status === "configured_no_match_in_pool") {
      assert.deepEqual(
        [...result.matchingIds].sort(),
        ["match-1", "match-2"],
      );
    }
  });

  it("returns `configured_match` restricted to the pool when both DB matches and pool overlap", () => {
    insertAgent(db, { id: "match-1", role: "code_reviewer" });
    insertAgent(db, { id: "match-2", role: "code_reviewer" });
    setSetting(db, "review_agent_role", "code_reviewer");
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model", {
      candidatePool: new Set(["match-2"]),
    });
    assert.equal(result.status, "configured_match");
    if (result.status === "configured_match") {
      assert.equal(result.agent.id, "match-2");
    }
  });

  it("returns `configured_no_match` when DB has no match even if pool would have allowed it", () => {
    // candidatePool listing an id that does not exist in agents must not
    // produce a match — DB filter is the source of truth.
    setSetting(db, "review_agent_role", "code_reviewer");
    const result = resolveStageAgentSelection(db, "review_agent_role", "review_agent_model", {
      candidatePool: new Set(["ghost-id"]),
    });
    assert.equal(result.status, "configured_no_match");
  });
});
