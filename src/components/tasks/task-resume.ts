import type { Agent } from "../../types/index.js";

export interface ResumeActionState {
  canUseAssigned: boolean;
  showSelector: boolean;
  resumeAgentId: string;
}

export function getResumeActionState(
  assignedAgent: Agent | undefined,
  idleAgents: Agent[],
  selectedAgentId: string,
): ResumeActionState {
  const canUseAssigned = !!assignedAgent && assignedAgent.status !== "working";
  if (canUseAssigned) {
    return {
      canUseAssigned: true,
      showSelector: false,
      resumeAgentId: assignedAgent.id,
    };
  }

  return {
    canUseAssigned: false,
    showSelector: idleAgents.length > 0,
    resumeAgentId: idleAgents.find((agent) => agent.id === selectedAgentId)?.id ?? idleAgents[0]?.id ?? "",
  };
}
