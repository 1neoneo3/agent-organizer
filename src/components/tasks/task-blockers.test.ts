import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskSummary } from "../../types/index.js";
import { collectTaskCardBlockers } from "./task-blockers.js";

function task(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    assigned_agent_id: null,
    project_path: null,
    status: overrides.status ?? "inbox",
    priority: 0,
    task_size: "small",
    task_number: overrides.task_number ?? null,
    depends_on: overrides.depends_on ?? null,
    planned_files: overrides.planned_files ?? null,
    controller_stage: overrides.controller_stage ?? null,
    refinement_completed_at: null,
    refinement_revision_requested_at: null,
    refinement_revision_completed_at: null,
    review_count: 0,
    directive_id: null,
    pr_url: null,
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
    created_at: 1,
    updated_at: 1,
    parent_task_number: null,
    child_task_numbers: null,
    has_refinement_plan: false,
  };
}

describe("collectTaskCardBlockers", () => {
  it("returns unfinished depends_on tasks for card display", () => {
    const blocked = task({ id: "blocked", depends_on: JSON.stringify(["#1", "#2"]) });
    const done = task({ id: "done", task_number: "#1", status: "done" });
    const active = task({ id: "active", task_number: "#2", status: "human_review" });

    const blockers = collectTaskCardBlockers(blocked, [blocked, done, active]);

    assert.deepEqual(blockers.dependencies, [{
      kind: "dependency",
      taskId: "active",
      taskNumber: "#2",
      status: "human_review",
    }]);
  });

  it("returns active file conflicts and overlapping files", () => {
    const blocked = task({
      id: "blocked",
      task_number: "#3",
      planned_files: JSON.stringify(["server/routes/tasks.ts", "src/other.ts"]),
    });
    const conflict = task({
      id: "conflict",
      task_number: "#4",
      status: "pr_review",
      planned_files: JSON.stringify(["server/routes/tasks.ts", "README.md"]),
    });
    const finished = task({
      id: "finished",
      task_number: "#5",
      status: "done",
      planned_files: JSON.stringify(["src/other.ts"]),
    });

    const blockers = collectTaskCardBlockers(blocked, [blocked, conflict, finished]);

    assert.deepEqual(blockers.fileConflicts, [{
      kind: "file_conflict",
      taskId: "conflict",
      taskNumber: "#4",
      status: "pr_review",
      overlappingFiles: ["server/routes/tasks.ts"],
    }]);
  });
});
