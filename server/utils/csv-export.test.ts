import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tasksToCsv, CSV_COLUMNS } from "./csv-export.js";

describe("CSV_COLUMNS", () => {
  it("exports a non-empty list of column definitions", () => {
    assert.ok(CSV_COLUMNS.length > 0);
    for (const col of CSV_COLUMNS) {
      assert.ok(col.key, "each column must have a key");
      assert.ok(col.header, "each column must have a header");
    }
  });
});

describe("tasksToCsv", () => {
  it("returns only the header row for an empty task list", () => {
    const csv = tasksToCsv([]);
    const lines = csv.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("ID"));
    assert.ok(lines[0].includes("Title"));
  });

  it("produces one header row plus one data row per task", () => {
    const tasks = [
      makeTask({ id: "t1", title: "First task" }),
      makeTask({ id: "t2", title: "Second task" }),
    ];
    const csv = tasksToCsv(tasks);
    const lines = csv.split("\n").filter(Boolean);
    assert.equal(lines.length, 3);
  });

  it("includes core fields in the output", () => {
    const task = makeTask({
      id: "abc-123",
      title: "Do something",
      status: "done",
      priority: 5,
      task_size: "medium",
    });
    const csv = tasksToCsv([task]);
    const lines = csv.split("\n").filter(Boolean);
    const dataLine = lines[1];
    assert.ok(dataLine.includes("abc-123"));
    assert.ok(dataLine.includes("Do something"));
    assert.ok(dataLine.includes("done"));
    assert.ok(dataLine.includes("5"));
    assert.ok(dataLine.includes("medium"));
  });

  it("escapes commas in field values", () => {
    const task = makeTask({ title: "Fix bug, urgent" });
    const csv = tasksToCsv([task]);
    const dataLine = csv.split("\n").filter(Boolean)[1];
    assert.ok(dataLine.includes('"Fix bug, urgent"'));
  });

  it("escapes double quotes in field values", () => {
    const task = makeTask({ title: 'Say "hello"' });
    const csv = tasksToCsv([task]);
    const dataLine = csv.split("\n").filter(Boolean)[1];
    assert.ok(dataLine.includes('"Say ""hello"""'));
  });

  it("escapes newlines in field values", () => {
    const task = makeTask({ description: "line1\nline2" });
    const csv = tasksToCsv([task]);
    assert.ok(csv.includes('"line1\nline2"'));
  });

  it("formats unix timestamps as ISO 8601 strings", () => {
    const ts = 1700000000000;
    const task = makeTask({ created_at: ts, completed_at: ts });
    const csv = tasksToCsv([task]);
    const dataLine = csv.split("\n").filter(Boolean)[1];
    const iso = new Date(ts).toISOString();
    assert.ok(dataLine.includes(iso));
  });

  it("renders null fields as empty strings", () => {
    const task = makeTask({
      description: null,
      assigned_agent_id: null,
      completed_at: null,
    });
    const csv = tasksToCsv([task]);
    const dataLine = csv.split("\n").filter(Boolean)[1];
    assert.ok(dataLine.includes(",,"), "null fields should produce empty CSV cells");
  });

  it("handles tasks with all null optional fields", () => {
    const task = makeTask({
      description: null,
      assigned_agent_id: null,
      project_path: null,
      result: null,
      pr_url: null,
      depends_on: null,
      task_number: null,
      started_at: null,
      completed_at: null,
    });
    const csv = tasksToCsv([task]);
    const lines = csv.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
  });

  it("uses UTF-8 BOM prefix for Excel compatibility", () => {
    const csv = tasksToCsv([]);
    assert.ok(csv.startsWith("\uFEFF"), "CSV should start with UTF-8 BOM");
  });
});

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-id",
    title: "Test Task",
    description: null,
    assigned_agent_id: null,
    project_path: null,
    status: "done",
    priority: 0,
    task_size: "small",
    task_number: "#1",
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
    created_at: 1700000000000,
    updated_at: 1700000000000,
    ...overrides,
  };
}
