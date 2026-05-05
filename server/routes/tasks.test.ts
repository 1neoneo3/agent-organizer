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
  function insertSetting(db: DatabaseSync, key: string, value: string): void {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

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

  it("ignores deprecated in_progress_agent_id and keeps an assigned implementer", () => {
    const db = createDb();
    insertAgent(db, { id: "assigned-impl", role: "lead_engineer" });
    insertAgent(db, { id: "deprecated-pin", role: "architect" });
    insertSetting(db, "in_progress_agent_id", "deprecated-pin");

    const result = resolveImplementerAgentForExecution(db, "assigned-impl", undefined, {
      taskId: "task-1",
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.agent.id, "assigned-impl");
    assert.equal(result.source, "assigned");
  });

  it("uses the implementation role/model pool", () => {
    const db = createDb();
    insertAgent(db, { id: "non-matching-impl", role: "lead_engineer", cli_model: "gpt-5.4" });
    insertAgent(db, { id: "pool-impl", role: "architect", cli_model: "gpt-5.5" });
    insertSetting(db, "implementation_agent_role", "architect");
    insertSetting(db, "implementation_agent_model", "gpt-5.5");

    const result = resolveImplementerAgentForExecution(db, null, undefined, {
      taskId: "task-1",
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.agent.id, "pool-impl");
    assert.equal(result.source, "configured_pool");
  });

  it("uses another matching implementation pool agent when the first was consumed this tick", () => {
    const db = createDb();
    insertAgent(db, { id: "pool-1", role: "lead_engineer", cli_model: "gpt-5.5", stats_tasks_done: 0 });
    insertAgent(db, { id: "pool-2", role: "lead_engineer", cli_model: "gpt-5.5", stats_tasks_done: 1 });
    insertSetting(db, "implementation_agent_role", "lead_engineer");
    insertSetting(db, "implementation_agent_model", "gpt-5.5");

    const result = resolveImplementerAgentForExecution(db, null, undefined, {
      taskId: "task-1",
      excludeIds: ["pool-1"],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.agent.id, "pool-2");
    assert.equal(result.source, "configured_pool");
  });

  it("does not fall back to a non-matching implementer when implementation pool is configured", () => {
    const db = createDb();
    insertAgent(db, { id: "fallback-impl", role: "architect", cli_model: "gpt-5.4" });
    insertSetting(db, "implementation_agent_role", "lead_engineer");
    insertSetting(db, "implementation_agent_model", "gpt-5.5");

    const result = resolveImplementerAgentForExecution(db, null, undefined, {
      taskId: "task-1",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "no_implementer_available");
  });

  it("falls back normally when deprecated in_progress_agent_id points to a busy agent", () => {
    const db = createDb();
    insertAgent(db, {
      id: "deprecated-pin",
      role: "lead_engineer",
      status: "working",
      current_task_id: "other-task",
    });
    insertAgent(db, { id: "fallback-impl", role: "architect" });
    insertSetting(db, "in_progress_agent_id", "deprecated-pin");

    const result = resolveImplementerAgentForExecution(db, null, undefined, {
      taskId: "task-1",
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.agent.id, "fallback-impl");
    assert.equal(result.source, "fallback");
  });

  it("excludes refinement runner when resolving the implementation fallback", () => {
    const db = createDb();
    insertAgent(db, { id: "refinement-runner", role: "planner" });
    insertAgent(db, { id: "fallback-impl", role: "architect" });

    const result = resolveImplementerAgentForExecution(db, "refinement-runner", undefined, {
      taskId: "task-1",
      excludeIds: ["refinement-runner"],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.agent.id, "fallback-impl");
    assert.equal(result.source, "fallback");
  });
});
