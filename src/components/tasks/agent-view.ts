import type { Agent } from "../../types/index.js";
import { getRoleLabel } from "../agents/roles.js";

export interface AgentViewState {
  agentById: Map<string, Agent>;
  idleAgents: Agent[];
  roleLabelById: Map<string, string>;
}

export function buildAgentViewState(agents: Agent[]): AgentViewState {
  const agentById = new Map<string, Agent>();
  const idleAgents: Agent[] = [];
  const roleLabelById = new Map<string, string>();

  for (const agent of agents) {
    agentById.set(agent.id, agent);
    if (agent.status === "idle") {
      idleAgents.push(agent);
    }
    const roleLabel = getRoleLabel(agent.role);
    if (roleLabel) {
      roleLabelById.set(agent.id, roleLabel);
    }
  }

  return { agentById, idleAgents, roleLabelById };
}
