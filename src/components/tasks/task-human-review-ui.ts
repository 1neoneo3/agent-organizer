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

export interface HumanReviewLimitUi {
  badge: {
    label: "Maxed";
    color: string;
    background: string;
  };
  banner: {
    label: "Auto Human Review Limit Reached";
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

export function getHumanReviewLimitUi(
  task: Pick<TaskSummary, "human_review_auto_status">,
): HumanReviewLimitUi | null {
  if (task.human_review_auto_status !== "exhausted") {
    return null;
  }

  return {
    badge: {
      label: "Maxed",
      color: "var(--status-human-review)",
      background: "var(--bg-tertiary)",
    },
    banner: {
      label: "Auto Human Review Limit Reached",
      color: "var(--status-human-review)",
      description: "Automatic human-review checks reached the configured limit. Review the task manually before approving or rejecting it.",
    },
  };
}
