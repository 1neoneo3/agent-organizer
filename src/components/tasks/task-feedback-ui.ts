import type { TaskSummary } from "../../types/index.js";

export interface TaskFeedbackUi {
  detailHeading: string;
  detailDescription: string;
  detailPlaceholder: string;
  detailSendLabel: string;
  cardDescription?: string;
  cardActionLabel?: string;
}

export function getTaskFeedbackUi(status: TaskSummary["status"]): TaskFeedbackUi | null {
  switch (status) {
    case "in_progress":
      return {
        detailHeading: "Feedback",
        detailDescription: "Send feedback to the running agent without leaving this task.",
        detailPlaceholder: "Send feedback to the running agent...",
        detailSendLabel: "Send",
      };
    case "human_review":
      return {
        detailHeading: "Feedback",
        detailDescription: "Request changes here before approving or rejecting the review.",
        detailPlaceholder: "Describe the changes you want before sending this task back...",
        detailSendLabel: "Send Feedback",
        cardDescription: "Open detail to request changes before approving or rejecting.",
        cardActionLabel: "Feedback",
      };
    default:
      return null;
  }
}
