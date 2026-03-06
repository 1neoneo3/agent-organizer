import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../types/index.js";
import { buildAgentViewState } from "./agent-view.js";

function createAgent(id: string, status: Agent["status"], role: Agent["role"]): Agent {
  return {
    id,
    name: `Agent ${id}`,
    cli_provider: "claude",
    cli_model: null,
    cli_reasoning_level: null,
    avatar_emoji: "A",
    role,
    agent_type: "worker",
    personality: null,
    status,
    current_task_id: null,
    stats_tasks_done: 0,
    created_at: 1,
    updated_at: 1,
  };
}

describe("buildAgentViewState", () => {
  it("indexes agents and extracts idle agents with role labels", () => {
    const state = buildAgentViewState([
      createAgent("a1", "idle", "lead_engineer"),
      createAgent("a2", "working", null),
    ]);

    assert.equal(state.agentById.get("a1")?.name, "Agent a1");
    assert.equal(state.idleAgents.length, 1);
    assert.equal(state.idleAgents[0]?.id, "a1");
    assert.equal(state.roleLabelById.get("a1"), "Lead Engineer");
    assert.equal(state.roleLabelById.has("a2"), false);
  });
});
