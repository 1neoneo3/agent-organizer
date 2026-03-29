import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExampleTask, getPriorityLabel, summarizeExampleTasks } from "./typescript-basics.js";

describe("buildExampleTask", () => {
  it("creates a typed task object with default flags", () => {
    const task = buildExampleTask({
      id: 1,
      title: "Learn TypeScript",
      priority: "medium",
      tags: ["typescript", "basics"],
    });

    assert.deepEqual(task, {
      id: 1,
      title: "Learn TypeScript",
      completed: false,
      priority: "medium",
      tags: ["typescript", "basics"],
    });
  });
});

describe("getPriorityLabel", () => {
  it("maps union types to readable labels", () => {
    assert.equal(getPriorityLabel("low"), "Low Priority");
    assert.equal(getPriorityLabel("medium"), "Medium Priority");
    assert.equal(getPriorityLabel("high"), "High Priority");
  });
});

describe("summarizeExampleTasks", () => {
  it("returns immutable summary data from readonly tasks", () => {
    const tasks = [
      buildExampleTask({ id: 1, title: "Setup", priority: "high", completed: true, tags: ["setup"] }),
      buildExampleTask({ id: 2, title: "Practice", priority: "medium", tags: ["practice"] }),
      buildExampleTask({ id: 3, title: "Review", priority: "low", tags: ["review"] }),
    ] as const;

    const summary = summarizeExampleTasks(tasks);

    assert.deepEqual(summary, {
      total: 3,
      completedCount: 1,
      pendingTitles: ["Practice", "Review"],
    });
    assert.deepEqual(tasks[1].tags, ["practice"]);
  });
});
