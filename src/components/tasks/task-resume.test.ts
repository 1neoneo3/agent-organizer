import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../types/index.js";
import { getResumeActionState } from "./task-resume.js";

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? "agent-1",
    name: overrides.name ?? "Agent 1",
    cli_provider: overrides.cli_provider ?? "codex",
    cli_model: overrides.cli_model ?? null,
    cli_reasoning_level: overrides.cli_reasoning_level ?? null,
    avatar_emoji: overrides.avatar_emoji ?? "🤖",
    role: overrides.role ?? null,
    agent_type: overrides.agent_type ?? "worker",
    personality: overrides.personality ?? null,
    status: overrides.status ?? "idle",
    current_task_id: overrides.current_task_id ?? null,
    stats_tasks_done: overrides.stats_tasks_done ?? 0,
    created_at: overrides.created_at ?? 1,
    updated_at: overrides.updated_at ?? 1,
  };
}

describe("getResumeActionState", () => {
  it("prefers the assigned agent when it is available", () => {
    const assignedAgent = createAgent({ id: "assigned" });
    const idleAgents = [createAgent({ id: "fallback" })];

    assert.deepStrictEqual(getResumeActionState(assignedAgent, idleAgents, "fallback"), {
      canUseAssigned: true,
      showSelector: false,
      resumeAgentId: "assigned",
    });
  });

  it("uses the selected idle agent when the assigned agent is busy", () => {
    const assignedAgent = createAgent({ id: "assigned", status: "working" });
    const idleAgents = [
      createAgent({ id: "agent-1" }),
      createAgent({ id: "agent-2" }),
    ];

    assert.deepStrictEqual(getResumeActionState(assignedAgent, idleAgents, "agent-2"), {
      canUseAssigned: false,
      showSelector: true,
      resumeAgentId: "agent-2",
    });
  });

  it("falls back to the first idle agent when nothing is selected", () => {
    const idleAgents = [
      createAgent({ id: "agent-1" }),
      createAgent({ id: "agent-2" }),
    ];

    assert.deepStrictEqual(getResumeActionState(undefined, idleAgents, ""), {
      canUseAssigned: false,
      showSelector: true,
      resumeAgentId: "agent-1",
    });
  });

  it("disables restart when no agent is available", () => {
    assert.deepStrictEqual(getResumeActionState(undefined, [], ""), {
      canUseAssigned: false,
      showSelector: false,
      resumeAgentId: "",
    });
  });
});
