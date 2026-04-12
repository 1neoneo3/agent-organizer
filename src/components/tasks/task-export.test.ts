import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "../../types/index.js";
import { getCompletedTaskExportState } from "./task-export.js";

function createTask(id: string, status: Task["status"]): Task {
  return {
    id,
    title: id,
    description: null,
    assigned_agent_id: null,
    project_path: null,
    status,
    priority: 0,
    task_size: "small",
    task_number: null,
    depends_on: null,
    result: null,
    refinement_plan: null,
    pr_url: null,
    review_count: 0,
    directive_id: null,
    external_source: null,
    external_id: null,
    repository_url: null,
    started_at: null,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("getCompletedTaskExportState", () => {
  it("counts only done tasks for reporting", () => {
    const state = getCompletedTaskExportState([
      createTask("done-1", "done"),
      createTask("done-2", "done"),
      createTask("cancelled-1", "cancelled"),
      createTask("inbox-1", "inbox"),
    ]);

    assert.equal(state.completedCount, 2);
    assert.equal(state.hasCompletedTasks, true);
  });

  it("builds a done-only CSV export URL", () => {
    const state = getCompletedTaskExportState([]);

    assert.equal(state.href, "/api/tasks/export/csv?status=done");
  });

  it("disables export when there are no completed tasks", () => {
    const state = getCompletedTaskExportState([
      createTask("cancelled-1", "cancelled"),
      createTask("review-1", "self_review"),
    ]);

    assert.equal(state.completedCount, 0);
    assert.equal(state.hasCompletedTasks, false);
  });
});
