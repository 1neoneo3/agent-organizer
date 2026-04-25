import type { TaskSummary } from "../../types/index.js";
import { getRefinementRevisionState } from "./task-refinement-state.js";
import {
  getPlanBanner,
  getRevisionBadge,
  type PlanBanner,
  type RevisionBadge,
} from "./task-card-badges.js";

export type TaskRevisionBadgeUi = RevisionBadge;
export type TaskPlanBannerUi = PlanBanner;

export function getTaskRevisionUi(
  task: Pick<
    TaskSummary,
    "status" | "refinement_completed_at" | "refinement_revision_requested_at" | "refinement_revision_completed_at"
  >,
): {
  revisionBadge: TaskRevisionBadgeUi | null;
  planBanner: TaskPlanBannerUi | null;
} {
  const revisionState = getRefinementRevisionState(task);
  return {
    revisionBadge: getRevisionBadge(task.status, revisionState),
    planBanner: getPlanBanner(task.status, revisionState, Boolean(task.refinement_completed_at)),
  };
}
