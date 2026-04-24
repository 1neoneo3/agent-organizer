import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "../../types/index.js";
import { getTaskRevisionUi } from "./task-revision-ui.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task 1",
    description: null,
    assigned_agent_id: null,
    project_path: null,
    status: "refinement",
    priority: 0,
    task_size: "medium",
    task_number: null,
    depends_on: null,
    result: null,
    refinement_plan: null,
    refinement_completed_at: null,
    refinement_revision_requested_at: null,
    refinement_revision_completed_at: null,
    pr_url: null,
    review_count: 0,
    directive_id: null,
    external_source: null,
    external_id: null,
    repository_url: null,
    repository_urls: null,
    pr_urls: null,
    started_at: null,
    completed_at: null,
    auto_respawn_count: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("getTaskRevisionUi", () => {
  it("returns no revision UI for non-refinement tasks", () => {
    assert.deepEqual(
      getTaskRevisionUi(createTask({ status: "in_progress" })),
      {
        revisionBadge: null,
        planBanner: null,
      },
    );
  });

  it("returns implementation plan banner when a refinement plan is ready with no revision request", () => {
    assert.deepEqual(
      getTaskRevisionUi(createTask({
        refinement_plan: "---REFINEMENT PLAN---\nPlan\n---END REFINEMENT---",
      })),
      {
        revisionBadge: null,
        planBanner: {
          label: "Implementation Plan Ready",
          color: "var(--status-refinement)",
        },
      },
    );
  });

  it("returns revising status when a revision has been requested and is still pending", () => {
    assert.deepEqual(
      getTaskRevisionUi(createTask({
        refinement_plan: "---REFINEMENT PLAN---\nPlan\n---END REFINEMENT---",
        refinement_revision_requested_at: 2_000,
      })),
      {
        revisionBadge: {
          label: "Revising",
          color: "var(--status-progress)",
          background: "var(--bg-tertiary)",
        },
        planBanner: {
          label: "Revision Requested",
          color: "var(--status-progress)",
        },
      },
    );
  });

  it("keeps the revising state visible even before the revised plan is persisted", () => {
    assert.deepEqual(
      getTaskRevisionUi(createTask({
        refinement_revision_requested_at: 2_000,
      })),
      {
        revisionBadge: {
          label: "Revising",
          color: "var(--status-progress)",
          background: "var(--bg-tertiary)",
        },
        planBanner: {
          label: "Revision Requested",
          color: "var(--status-progress)",
        },
      },
    );
  });

  it("returns revised status when the latest revision has completed", () => {
    assert.deepEqual(
      getTaskRevisionUi(createTask({
        refinement_plan: "---REFINEMENT PLAN---\nPlan\n---END REFINEMENT---",
        refinement_revision_requested_at: 2_000,
        refinement_revision_completed_at: 3_000,
      })),
      {
        revisionBadge: {
          label: "Revised",
          color: "var(--status-done)",
          background: "var(--bg-tertiary)",
        },
        planBanner: {
          label: "Revised Plan Ready",
          color: "var(--status-done)",
        },
      },
    );
  });

  it("keeps the revising state when the saved completion timestamp is older than the latest request", () => {
    assert.deepEqual(
      getTaskRevisionUi(createTask({
        refinement_plan: "---REFINEMENT PLAN---\nPlan\n---END REFINEMENT---",
        refinement_revision_requested_at: 3_000,
        refinement_revision_completed_at: 2_000,
      })),
      {
        revisionBadge: {
          label: "Revising",
          color: "var(--status-progress)",
          background: "var(--bg-tertiary)",
        },
        planBanner: {
          label: "Revision Requested",
          color: "var(--status-progress)",
        },
      },
    );
  });

  it("treats same-tick request and completion as revised when the updated plan is present", () => {
    assert.deepEqual(
      getTaskRevisionUi(createTask({
        refinement_plan: "---REFINEMENT PLAN---\nPlan\n---END REFINEMENT---",
        refinement_revision_requested_at: 4_000,
        refinement_revision_completed_at: 4_000,
      })),
      {
        revisionBadge: {
          label: "Revised",
          color: "var(--status-done)",
          background: "var(--bg-tertiary)",
        },
        planBanner: {
          label: "Revised Plan Ready",
          color: "var(--status-done)",
        },
      },
    );
  });

  it("ignores stale completed timestamps when no revision request exists", () => {
    assert.deepEqual(
      getTaskRevisionUi(createTask({
        refinement_plan: "---REFINEMENT PLAN---\nPlan\n---END REFINEMENT---",
        refinement_revision_requested_at: null,
        refinement_revision_completed_at: 3_000,
      })),
      {
        revisionBadge: null,
        planBanner: {
          label: "Implementation Plan Ready",
          color: "var(--status-refinement)",
        },
      },
    );
  });

  it("keeps only the revised badge when the plan has not been persisted yet", () => {
    assert.deepEqual(
      getTaskRevisionUi(createTask({
        refinement_revision_requested_at: 2_000,
        refinement_revision_completed_at: 3_000,
      })),
      {
        revisionBadge: {
          label: "Revised",
          color: "var(--status-done)",
          background: "var(--bg-tertiary)",
        },
        planBanner: null,
      },
    );
  });
});
