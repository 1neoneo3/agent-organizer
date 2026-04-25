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
    "status"
    | "refinement_completed_at"
    | "refinement_revision_requested_at"
    | "refinement_revision_completed_at"
    | "has_refinement_plan"
  >,
): {
  revisionBadge: TaskRevisionBadgeUi | null;
  planBanner: TaskPlanBannerUi | null;
} {
  const revisionState = getRefinementRevisionState(task);
  return {
    revisionBadge: getRevisionBadge(task.status, revisionState),
    // `has_refinement_plan` is the server-derived boolean (see
    // server/domain/task-derived-fields.ts). We use it instead of
    // `refinement_completed_at` because the latter only flips after
    // refinement finalization, missing the in-flight refinement state
    // where a plan exists in DB but completion is not yet stamped.
    planBanner: getPlanBanner(task.status, revisionState, Boolean(task.has_refinement_plan)),
  };
}
