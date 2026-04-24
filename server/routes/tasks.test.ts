import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import type { Agent } from "../types/runtime.js";
import {
  buildContinuePromptFromInteractiveResponse,
  getInteractivePromptTypeMismatch,
  resolveImplementerAgentForExecution,
  resolveRequestedAgentId,
} from "./tasks.js";

describe("getInteractivePromptTypeMismatch", () => {
  it("returns null when the pending prompt type matches the request", () => {
    assert.equal(getInteractivePromptTypeMismatch("exit_plan_mode", "exit_plan_mode"), null);
  });

  it("returns the expected pending prompt type when the request mismatches", () => {
    assert.equal(
      getInteractivePromptTypeMismatch("exit_plan_mode", "ask_user_question"),
      "ask_user_question",
    );
  });
});

describe("buildContinuePromptFromInteractiveResponse", () => {
  it("builds an approval message for exit plan mode", () => {
    assert.equal(
      buildContinuePromptFromInteractiveResponse({
        promptType: "exit_plan_mode",
        approved: true,
      }),
      "The user has approved your plan. Proceed with the implementation.",
    );
  });

  it("includes free text answers for ask user question prompts", () => {
    assert.equal(
      buildContinuePromptFromInteractiveResponse({
        promptType: "ask_user_question",
        selectedOptions: { scope: "full" },
        freeText: "Include regression coverage.",
      }),
      "The user has responded to your questions:\n\nQ: scope\nA: full\n\nInclude regression coverage.",
    );
  });
});

describe("resolveRequestedAgentId", () => {
  it("prefers the explicit request agent over the task assignment", () => {
    assert.equal(resolveRequestedAgentId("assigned-agent", "requested-agent"), "requested-agent");
  });

  it("falls back to the task assignment when no request agent is provided", () => {
    assert.equal(resolveRequestedAgentId("assigned-agent", undefined), "assigned-agent");
  });

  it("returns undefined when neither source provides an agent", () => {
    assert.equal(resolveRequestedAgentId(null, undefined), undefined);
  });
});

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function insertAgent(db: DatabaseSync, overrides: Partial<Agent>): Agent {
  const now = Date.now();
  const id = overrides.id ?? "agent-1";
  const agent: Agent = {
    id,
    name: overrides.name ?? `Agent ${id}`,
    cli_provider: overrides.cli_provider ?? "codex",
    cli_model: overrides.cli_model ?? null,
    cli_reasoning_level: overrides.cli_reasoning_level ?? null,
    avatar_emoji: overrides.avatar_emoji ?? ":robot:",
    role: overrides.role ?? null,
    agent_type: overrides.agent_type ?? "worker",
    personality: overrides.personality ?? null,
    status: overrides.status ?? "idle",
    current_task_id: overrides.current_task_id ?? null,
    stats_tasks_done: overrides.stats_tasks_done ?? 0,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };

  db.prepare(
    `INSERT INTO agents (
      id, name, cli_provider, cli_model, cli_reasoning_level, avatar_emoji, role, personality,
      status, current_task_id, stats_tasks_done, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agent.id,
    agent.name,
    agent.cli_provider,
    agent.cli_model,
    agent.cli_reasoning_level,
    agent.avatar_emoji,
    agent.role,
    agent.personality,
    agent.status,
    agent.current_task_id,
    agent.stats_tasks_done,
    agent.created_at,
    agent.updated_at,
  );

  return agent;
}

describe("resolveImplementerAgentForExecution", () => {
  it("falls back from a stale reviewer assignment to an idle implementer", () => {
    const db = createDb();
    insertAgent(db, { id: "reviewer-1", role: "code_reviewer" });
    insertAgent(db, { id: "impl-1", role: "lead_engineer" });

    const result = resolveImplementerAgentForExecution(db, "reviewer-1", undefined);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.agent.id, "impl-1");
    assert.equal(result.source, "fallback");
  });

  it("rejects an explicit non-implementer request", () => {
    const db = createDb();
    insertAgent(db, { id: "reviewer-1", role: "code_reviewer" });
    insertAgent(db, { id: "impl-1", role: "lead_engineer" });

    const result = resolveImplementerAgentForExecution(db, "impl-1", "reviewer-1");
    assert.deepEqual(result, { ok: false, error: "non_implementer_agent" });
  });

  it("keeps an assigned implementer when it is idle", () => {
    const db = createDb();
    insertAgent(db, { id: "impl-1", role: "lead_engineer" });
    insertAgent(db, { id: "impl-2", role: "architect" });

    const result = resolveImplementerAgentForExecution(db, "impl-1", undefined);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.agent.id, "impl-1");
    assert.equal(result.source, "assigned");
  });
});
