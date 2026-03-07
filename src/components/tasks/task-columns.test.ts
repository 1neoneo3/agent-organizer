import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "../../types/index.js";
import { TASK_BOARD_COLUMNS, createEmptyTaskColumns, groupTasksByStatusStable } from "./task-columns.js";

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
    pr_url: null,
    review_count: 0,
    directive_id: null,
    started_at: null,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("groupTasksByStatusStable", () => {
  it("keeps the cancelled column to the right of done", () => {
    const orderedStatuses = TASK_BOARD_COLUMNS.map((column) => column.key);

    assert.deepEqual(orderedStatuses.slice(-2), ["done", "cancelled"]);
  });

  it("groups tasks into kanban columns", () => {
    const task1 = createTask("t1", "inbox");
    const task2 = createTask("t2", "done");
    const task3 = createTask("t3", "cancelled");

    const grouped = groupTasksByStatusStable([task1, task2, task3]);
    const groupedByKey = grouped as Record<string, Task[]>;

    assert.deepEqual(grouped.inbox, [task1]);
    assert.deepEqual(grouped.done, [task2]);
    assert.deepEqual(groupedByKey.cancelled, [task3]);
    assert.deepEqual(grouped.pr_review, []);
  });

  it("creates an explicit cancelled column", () => {
    const emptyColumns = createEmptyTaskColumns() as Record<string, Task[]>;

    assert.deepEqual(emptyColumns.cancelled, []);
  });

  it("reuses previous column arrays when the column content is unchanged", () => {
    const task1 = createTask("t1", "inbox");
    const task2 = createTask("t2", "done");
    const task3 = createTask("t3", "cancelled");
    const previous = groupTasksByStatusStable([task1, task2, task3], createEmptyTaskColumns());
    const updatedTask2 = { ...task2, title: "t2-updated" };

    const grouped = groupTasksByStatusStable([task1, updatedTask2, task3], previous);
    const groupedByKey = grouped as Record<string, Task[]>;
    const previousByKey = previous as Record<string, Task[]>;

    assert.equal(grouped.inbox, previous.inbox);
    assert.notEqual(grouped.done, previous.done);
    assert.equal(groupedByKey.cancelled, previousByKey.cancelled);
  });
});
