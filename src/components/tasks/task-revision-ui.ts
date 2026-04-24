import type { Task } from "../../types/index.js";
import { getRefinementRevisionState } from "./task-refinement-state.js";

export interface TaskRevisionBadgeUi {
  label: "Revising" | "Revised";
  color: string;
  background: string;
}

export interface TaskPlanBannerUi {
  label: "Revision Requested" | "Revised Plan Ready" | "Implementation Plan Ready";
  color: string;
}

export function getTaskRevisionUi(
  task: Pick<
    Task,
    "status" | "refinement_plan" | "refinement_revision_requested_at" | "refinement_revision_completed_at"
  >,
): {
  revisionBadge: TaskRevisionBadgeUi | null;
  planBanner: TaskPlanBannerUi | null;
} {
  if (task.status !== "refinement") {
    return {
      revisionBadge: null,
      planBanner: null,
    };
  }

  const refinementRevisionState = getRefinementRevisionState(task);
  const revisionBadge =
    refinementRevisionState === "not_requested"
      ? null
      : refinementRevisionState === "completed"
        ? {
            label: "Revised" as const,
            color: "var(--status-done)",
            background: "var(--bg-tertiary)",
          }
        : {
            label: "Revising" as const,
            color: "var(--status-progress)",
            background: "var(--bg-tertiary)",
          };

  const planBanner =
    refinementRevisionState === "pending"
      ? { label: "Revision Requested" as const, color: "var(--status-progress)" }
      : task.refinement_plan
        ? {
            label:
              refinementRevisionState === "completed"
                ? "Revised Plan Ready" as const
                : "Implementation Plan Ready" as const,
            color:
              refinementRevisionState === "completed"
                ? "var(--status-done)"
                : "var(--status-refinement)",
          }
        : null;

  return {
    revisionBadge,
    planBanner,
  };
}
