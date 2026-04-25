import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskSummary } from "../../types/index.js";
import { getTaskRevisionUi } from "./task-revision-ui.js";

function createTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "task-1",
    title: "Task 1",
    assigned_agent_id: null,
    project_path: null,
    status: "refinement",
    priority: 0,
    task_size: "medium",
    task_number: null,
    depends_on: null,
    refinement_completed_at: null,
    refinement_revision_requested_at: null,
    refinement_revision_completed_at: null,
    pr_url: null,
    review_count: 0,
    directive_id: null,
    external_source: null,
    external_id: null,
    review_branch: null,
    review_commit_sha: null,
    review_sync_status: null,
    review_sync_error: null,
    repository_url: null,
    settings_overrides: null,
    started_at: null,
    completed_at: null,
    last_heartbeat_at: null,
    auto_respawn_count: 0,
    parent_task_number: null,
    child_task_numbers: null,
    has_refinement_plan: false,
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
        refinement_completed_at: 1000,
        has_refinement_plan: true,
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
        refinement_completed_at: 1000,
        has_refinement_plan: true,
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
        refinement_completed_at: 1000,
        has_refinement_plan: true,
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
