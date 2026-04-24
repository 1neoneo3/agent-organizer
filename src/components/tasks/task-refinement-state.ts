import type { Task } from "../../types/index.js";

export type RefinementRevisionState = "not_requested" | "pending" | "completed";

export function getRefinementRevisionState(
  task: Pick<
    Task,
    "refinement_revision_requested_at" | "refinement_revision_completed_at"
  >,
): RefinementRevisionState {
  const requestedAt = task.refinement_revision_requested_at ?? null;
  if (requestedAt === null) {
    return "not_requested";
  }

  const completedAt = task.refinement_revision_completed_at ?? null;
  if (completedAt !== null && completedAt >= requestedAt) {
    return "completed";
  }

  return "pending";
}
