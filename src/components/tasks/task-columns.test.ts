import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskSummary } from "../../types/index.js";
import {
  TASK_BOARD_COLUMNS,
  createEmptyTaskColumns,
  getTaskPriorityBucket,
  groupTasksByStatusStable,
  summarizeTaskColumn,
  summarizeTaskColumns,
} from "./task-columns.js";

function createTask(id: string, status: TaskSummary["status"], createdAt = 1): TaskSummary {
  return {
    id,
    title: id,
    assigned_agent_id: null,
    project_path: null,
    status,
    priority: 0,
    task_size: "small",
    task_number: null,
    depends_on: null,
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
    created_at: createdAt,
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
    const groupedByKey = grouped as Record<string, TaskSummary[]>;

    assert.deepEqual(grouped.inbox, [task1]);
    assert.deepEqual(grouped.done, [task2]);
    assert.deepEqual(groupedByKey.cancelled, [task3]);
    assert.deepEqual(grouped.pr_review, []);
  });

  it("creates an explicit cancelled column", () => {
    const emptyColumns = createEmptyTaskColumns() as Record<string, TaskSummary[]>;

    assert.deepEqual(emptyColumns.cancelled, []);
  });

  it("reuses previous column arrays when the column content is unchanged", () => {
    const task1 = createTask("t1", "inbox");
    const task2 = createTask("t2", "done");
    const task3 = createTask("t3", "cancelled");
    const previous = groupTasksByStatusStable([task1, task2, task3], createEmptyTaskColumns());
    const updatedTask2 = { ...task2, title: "t2-updated" };

    const grouped = groupTasksByStatusStable([task1, updatedTask2, task3], previous);
    const groupedByKey = grouped as Record<string, TaskSummary[]>;
    const previousByKey = previous as Record<string, TaskSummary[]>;

    assert.equal(grouped.inbox, previous.inbox);
    assert.notEqual(grouped.done, previous.done);
    assert.equal(groupedByKey.cancelled, previousByKey.cancelled);
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

describe("getTaskPriorityBucket", () => {
  it("maps priority values into fixed buckets", () => {
    assert.equal(getTaskPriorityBucket(9), "high");
    assert.equal(getTaskPriorityBucket(8), "high");
    assert.equal(getTaskPriorityBucket(7), "medium");
    assert.equal(getTaskPriorityBucket(4), "medium");
    assert.equal(getTaskPriorityBucket(3), "low");
    assert.equal(getTaskPriorityBucket(0), "low");
  });

  it("treats negative priorities as low", () => {
    assert.equal(getTaskPriorityBucket(-1), "low");
    assert.equal(getTaskPriorityBucket(-100), "low");
  });

  it("treats very large priorities as high", () => {
    assert.equal(getTaskPriorityBucket(100), "high");
    assert.equal(getTaskPriorityBucket(999), "high");
  });
});

describe("summarizeTaskColumn", () => {
  it("returns zero counts for an empty column", () => {
    assert.deepEqual(summarizeTaskColumn([]), {
      total: 0,
      priorityBreakdown: {
        high: 0,
        medium: 0,
        low: 0,
      },
    });
  });

  it("counts total tasks and priority buckets for a column", () => {
    const summary = summarizeTaskColumn([
      { ...createTask("high-1", "inbox"), priority: 10 },
      { ...createTask("high-2", "inbox"), priority: 8 },
      { ...createTask("medium-1", "inbox"), priority: 5 },
      { ...createTask("low-1", "inbox"), priority: 1 },
    ]);

    assert.deepEqual(summary, {
      total: 4,
      priorityBreakdown: {
        high: 2,
        medium: 1,
        low: 1,
      },
    });
  });

  it("handles a single task", () => {
    const summary = summarizeTaskColumn([
      { ...createTask("only", "inbox"), priority: 5 },
    ]);

    assert.deepEqual(summary, {
      total: 1,
      priorityBreakdown: {
        high: 0,
        medium: 1,
        low: 0,
      },
    });
  });

  it("counts all tasks in same bucket correctly", () => {
    const summary = summarizeTaskColumn([
      { ...createTask("h1", "inbox"), priority: 8 },
      { ...createTask("h2", "inbox"), priority: 9 },
      { ...createTask("h3", "inbox"), priority: 10 },
    ]);

    assert.deepEqual(summary, {
      total: 3,
      priorityBreakdown: {
        high: 3,
        medium: 0,
        low: 0,
      },
    });
  });

  it("does not mutate the input array", () => {
    const tasks = [
      { ...createTask("t1", "inbox"), priority: 10 },
      { ...createTask("t2", "inbox"), priority: 1 },
    ];
    const snapshot = [...tasks];

    summarizeTaskColumn(tasks);

    assert.deepEqual(tasks, snapshot);
  });
});

describe("summarizeTaskColumns", () => {
  it("returns summaries for every kanban column", () => {
    const grouped = groupTasksByStatusStable([
      { ...createTask("inbox-high", "inbox", 100), priority: 10 },
      { ...createTask("inbox-low", "inbox", 90), priority: 2 },
      { ...createTask("done-medium", "done", 80), priority: 6 },
    ]);

    const summaries = summarizeTaskColumns(grouped);

    assert.deepEqual(summaries.inbox, {
      total: 2,
      priorityBreakdown: {
        high: 1,
        medium: 0,
        low: 1,
      },
    });
    assert.deepEqual(summaries.done, {
      total: 1,
      priorityBreakdown: {
        high: 0,
        medium: 1,
        low: 0,
      },
    });
    assert.deepEqual(summaries.cancelled, {
      total: 0,
      priorityBreakdown: {
        high: 0,
        medium: 0,
        low: 0,
      },
    });
  });

  it("returns all zero summaries when no tasks exist", () => {
    const emptyColumns = createEmptyTaskColumns();
    const summaries = summarizeTaskColumns(emptyColumns);
    const zeroSummary = {
      total: 0,
      priorityBreakdown: { high: 0, medium: 0, low: 0 },
    };

    for (const column of TASK_BOARD_COLUMNS) {
      assert.deepEqual(
        summaries[column.key],
        zeroSummary,
        `expected zero summary for ${column.key}`,
      );
    }
  });

  it("produces correct summaries across multiple populated columns", () => {
    const grouped = groupTasksByStatusStable([
      { ...createTask("ip-1", "in_progress", 100), priority: 9 },
      { ...createTask("ip-2", "in_progress", 90), priority: 4 },
      { ...createTask("pr-1", "pr_review", 80), priority: 1 },
      { ...createTask("qa-1", "qa_testing", 70), priority: 8 },
      { ...createTask("qa-2", "qa_testing", 60), priority: 8 },
    ]);

    const summaries = summarizeTaskColumns(grouped);

    assert.equal(summaries.in_progress.total, 2);
    assert.equal(summaries.in_progress.priorityBreakdown.high, 1);
    assert.equal(summaries.in_progress.priorityBreakdown.medium, 1);
    assert.equal(summaries.pr_review.total, 1);
    assert.equal(summaries.pr_review.priorityBreakdown.low, 1);
    assert.equal(summaries.qa_testing.total, 2);
    assert.equal(summaries.qa_testing.priorityBreakdown.high, 2);
  });
});
