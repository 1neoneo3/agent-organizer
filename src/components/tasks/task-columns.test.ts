import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "../../types/index.js";
import { TASK_BOARD_COLUMNS, createEmptyTaskColumns, groupTasksByStatusStable } from "./task-columns.js";

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
    external_source: null,
    external_id: null,
    repository_url: null,
    started_at: null,
    completed_at: null,
    created_at: createdAt,
    updated_at: 1,
  };
}

describe("TASK_BOARD_COLUMNS", () => {
  it("includes the logic column", () => {
    const logicColumn = TASK_BOARD_COLUMNS.find((col) => col.key === "logic");
    assert.ok(logicColumn, "logic column should exist");
    assert.equal(logicColumn.label, "LOGIC");
    assert.equal(logicColumn.town, "Logic");
    assert.equal(logicColumn.accentColor, "var(--status-logic)");
  });

  it("places logic column between in_progress and self_review", () => {
    const keys = TASK_BOARD_COLUMNS.map((col) => col.key);
    const inProgressIndex = keys.indexOf("in_progress");
    const logicIndex = keys.indexOf("logic");
    const selfReviewIndex = keys.indexOf("self_review");

    assert.ok(logicIndex > inProgressIndex, "logic should come after in_progress");
    assert.ok(logicIndex < selfReviewIndex, "logic should come before self_review");
    assert.equal(logicIndex, inProgressIndex + 1, "logic should be immediately after in_progress");
  });

  it("keeps done and cancelled as the last two columns", () => {
    const orderedStatuses = TASK_BOARD_COLUMNS.map((column) => column.key);
    assert.deepEqual(orderedStatuses.slice(-2), ["done", "cancelled"]);
  });

  it("has unique keys for all columns", () => {
    const keys = TASK_BOARD_COLUMNS.map((col) => col.key);
    const uniqueKeys = new Set(keys);
    assert.equal(uniqueKeys.size, keys.length, "all column keys should be unique");
  });

  it("has non-empty labels and towns for all columns", () => {
    for (const col of TASK_BOARD_COLUMNS) {
      assert.ok(col.label.length > 0, `column ${col.key} should have a label`);
      assert.ok(col.town.length > 0, `column ${col.key} should have a town`);
      assert.ok(col.accentColor.length > 0, `column ${col.key} should have an accentColor`);
    }
  });
});

describe("createEmptyTaskColumns", () => {
  it("includes an empty logic array", () => {
    const columns = createEmptyTaskColumns();
    assert.deepEqual(columns.logic, []);
  });

  it("creates empty arrays for all column keys", () => {
    const columns = createEmptyTaskColumns();
    for (const col of TASK_BOARD_COLUMNS) {
      const colKey = col.key as keyof typeof columns;
      assert.ok(Array.isArray(columns[colKey]), `column ${col.key} should be an array`);
      assert.equal(columns[colKey].length, 0, `column ${col.key} should be empty`);
    }
  });

  it("returns a new object each time (no shared state)", () => {
    const a = createEmptyTaskColumns();
    const b = createEmptyTaskColumns();
    assert.notEqual(a, b);
    assert.notEqual(a.logic, b.logic);
  });
});

describe("groupTasksByStatusStable", () => {
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

  it("places logic-status tasks into the logic column", () => {
    const logicTask = createTask("t-logic", "logic");
    const inboxTask = createTask("t-inbox", "inbox");

    const grouped = groupTasksByStatusStable([logicTask, inboxTask]);

    assert.deepEqual(grouped.logic, [logicTask]);
    assert.deepEqual(grouped.inbox, [inboxTask]);
  });

  it("handles multiple tasks in the logic column", () => {
    const task1 = createTask("t1", "logic", 100);
    const task2 = createTask("t2", "logic", 200);
    const task3 = createTask("t3", "logic", 300);

    const grouped = groupTasksByStatusStable([task1, task2, task3]);

    assert.equal(grouped.logic.length, 3);
    assert.deepEqual(grouped.logic, [task3, task2, task1]);
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

  it("reuses previous logic column when unchanged", () => {
    const logicTask = createTask("t1", "logic");
    const inboxTask = createTask("t2", "inbox");
    const previous = groupTasksByStatusStable([logicTask, inboxTask], createEmptyTaskColumns());

    const next = groupTasksByStatusStable([logicTask, inboxTask], previous);

    assert.equal(next.logic, previous.logic, "logic column reference should be reused");
    assert.equal(next.inbox, previous.inbox, "inbox column reference should be reused");
  });

  it("does not reuse logic column when a task is added", () => {
    const logicTask1 = createTask("t1", "logic");
    const previous = groupTasksByStatusStable([logicTask1], createEmptyTaskColumns());

    const logicTask2 = createTask("t2", "logic");
    const next = groupTasksByStatusStable([logicTask1, logicTask2], previous);

    assert.notEqual(next.logic, previous.logic, "logic column reference should change");
    assert.equal(next.logic.length, 2);
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

  it("sorts logic tasks by created_at descending", () => {
    const older = createTask("older", "logic", 100);
    const newer = createTask("newer", "logic", 200);

    const grouped = groupTasksByStatusStable([older, newer]);

    assert.deepEqual(grouped.logic, [newer, older]);
  });

  it("preserves stable sort for tasks with same created_at", () => {
    const a = createTask("a", "logic", 100);
    const b = createTask("b", "logic", 100);
    const c = createTask("c", "logic", 100);

    const grouped = groupTasksByStatusStable([a, b, c]);

    assert.deepEqual(grouped.logic, [a, b, c]);
  });

  it("handles empty task list", () => {
    const grouped = groupTasksByStatusStable([]);

    assert.deepEqual(grouped.logic, []);
    assert.deepEqual(grouped.inbox, []);
    assert.deepEqual(grouped.done, []);
  });

  it("distributes tasks across all column types correctly", () => {
    const tasks: Task[] = [
      createTask("t1", "inbox"),
      createTask("t2", "in_progress"),
      createTask("t3", "logic"),
      createTask("t4", "self_review"),
      createTask("t5", "test_generation"),
      createTask("t6", "qa_testing"),
      createTask("t7", "pr_review"),
      createTask("t8", "human_review"),
      createTask("t9", "pre_deploy"),
      createTask("t10", "done"),
      createTask("t11", "cancelled"),
    ];

    const grouped = groupTasksByStatusStable(tasks);

    assert.equal(grouped.inbox.length, 1);
    assert.equal(grouped.in_progress.length, 1);
    assert.equal(grouped.logic.length, 1);
    assert.equal(grouped.self_review.length, 1);
    assert.equal(grouped.test_generation.length, 1);
    assert.equal(grouped.qa_testing.length, 1);
    assert.equal(grouped.pr_review.length, 1);
    assert.equal(grouped.human_review.length, 1);
    assert.equal(grouped.pre_deploy.length, 1);
    assert.equal(grouped.done.length, 1);
    const groupedByKey = grouped as Record<string, Task[]>;
    assert.equal(groupedByKey.cancelled.length, 1);
  });
});
