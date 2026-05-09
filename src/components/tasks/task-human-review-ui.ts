import type { Agent, TaskSummary } from "../../types/index.js";

export interface HumanReviewRunUi {
  badge: {
    label: "Reviewing";
    color: string;
    background: string;
  };
  banner: {
    label: "Auto Human Review Running";
    color: string;
    description: string;
  };
}

export function getHumanReviewRunUi(
  task: Pick<TaskSummary, "status">,
  activeAgent?: Pick<Agent, "name"> | null,
): HumanReviewRunUi | null {
  if (task.status !== "human_review" || !activeAgent) {
    return null;
  }

  return {
    badge: {
      label: "Reviewing",
      color: "var(--status-progress)",
      background: "var(--bg-tertiary)",
    },
    banner: {
      label: "Auto Human Review Running",
      color: "var(--status-human-review)",
      description: `${activeAgent.name} is reviewing the completed work.`,
    },
  };
}
