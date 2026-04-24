import type { RefinementRevisionState } from "./task-refinement-state.js";

export interface RevisionBadge {
  label: string;
  color: string;
  background: string;
}

export interface PlanBanner {
  label: string;
  color: string;
}

export function getRevisionBadge(
  status: string,
  revisionState: RefinementRevisionState,
): RevisionBadge | null {
  if (status !== "refinement" || revisionState === "not_requested") {
    return null;
  }

  return revisionState === "completed"
    ? { label: "Revised", color: "var(--status-done)", background: "var(--bg-tertiary)" }
    : { label: "Revising", color: "var(--status-progress)", background: "var(--bg-tertiary)" };
}

export function getPlanBanner(
  status: string,
  revisionState: RefinementRevisionState,
  hasPlan: boolean,
): PlanBanner | null {
  if (status !== "refinement") {
    return null;
  }

  if (revisionState === "pending") {
    return { label: "Revision Requested", color: "var(--status-progress)" };
  }

  if (!hasPlan) {
    return null;
  }

  return revisionState === "completed"
    ? { label: "Revised Plan Ready", color: "var(--status-done)" }
    : { label: "Implementation Plan Ready", color: "var(--status-refinement)" };
}
