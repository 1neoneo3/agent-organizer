import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "../../types/index.js";
import { createEmptyTaskColumns, groupTasksByStatusStable } from "./task-columns.js";

function createTask(id: string, status: Task["status"], createdAt = 1): Task {
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
    pr_url: null,
    review_count: 0,
    directive_id: null,
    started_at: null,
    completed_at: null,
    created_at: createdAt,
    updated_at: 1,
  };
}

describe("groupTasksByStatusStable", () => {
  it("groups tasks into kanban columns", () => {
    const task1 = createTask("t1", "inbox");
    const task2 = createTask("t2", "done");

    const grouped = groupTasksByStatusStable([task1, task2]);

    assert.deepEqual(grouped.inbox, [task1]);
    assert.deepEqual(grouped.done, [task2]);
    assert.deepEqual(grouped.pr_review, []);
  });

  it("reuses previous column arrays when the column content is unchanged", () => {
    const task1 = createTask("t1", "inbox");
    const task2 = createTask("t2", "done");
    const previous = groupTasksByStatusStable([task1, task2], createEmptyTaskColumns());
    const updatedTask2 = { ...task2, title: "t2-updated" };

    const grouped = groupTasksByStatusStable([task1, updatedTask2], previous);

    assert.equal(grouped.inbox, previous.inbox);
    assert.notEqual(grouped.done, previous.done);
  });

  it("sorts tasks inside each column by created_at descending", () => {
    const olderInboxTask = createTask("older", "inbox", 100);
    const newestInboxTask = createTask("newest", "inbox", 300);
    const middleInboxTask = createTask("middle", "inbox", 200);

    const grouped = groupTasksByStatusStable([
      olderInboxTask,
      newestInboxTask,
      middleInboxTask,
    ]);

    assert.deepEqual(grouped.inbox, [
      newestInboxTask,
      middleInboxTask,
      olderInboxTask,
    ]);
  });
});
