import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import {
  formatBlockingDependencies,
  getBlockingDependencies,
  hasBlockingDependencies,
  parseDependsOn,
} from "./task-dependencies.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function insertTask(
  db: DatabaseSync,
  id: string,
  taskNumber: string,
  status: string,
): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, task_size, task_number) VALUES (?, ?, ?, 'small', ?)",
  ).run(id, `task ${taskNumber}`, status, taskNumber);
}

describe("parseDependsOn", () => {
  it("returns [] for null", () => {
    assert.deepStrictEqual(parseDependsOn(null), []);
  });

  it("returns [] for malformed JSON", () => {
    assert.deepStrictEqual(parseDependsOn("not json"), []);
  });

  it("returns [] when payload is not an array", () => {
    assert.deepStrictEqual(parseDependsOn('{"foo":"bar"}'), []);
  });

  it("parses a valid JSON array of task_numbers", () => {
    assert.deepStrictEqual(parseDependsOn('["#1","#2"]'), ["#1", "#2"]);
  });

  it("filters non-string elements", () => {
    assert.deepStrictEqual(parseDependsOn('["#1",42,null,"#2"]'), ["#1", "#2"]);
  });
});

describe("getBlockingDependencies", () => {
  it("returns [] when depends_on is null", () => {
    const db = createDb();
    assert.deepStrictEqual(getBlockingDependencies(db, { depends_on: null }), []);
  });

  it("returns [] when every dependency is done", () => {
    const db = createDb();
    insertTask(db, "d1", "#1", "done");
    insertTask(db, "d2", "#2", "done");
    const blockers = getBlockingDependencies(db, { depends_on: '["#1","#2"]' });
    assert.deepStrictEqual(blockers, []);
  });

  it("reports dependencies currently in_progress (the file-edit race case)", () => {
    // This is the core behavior the user asked for: if a dependency is
    // actively editing files (`in_progress`), the downstream task must
    // be held at inbox / refinement rather than advancing.
    const db = createDb();
    insertTask(db, "d1", "#1", "in_progress");
    const blockers = getBlockingDependencies(db, { depends_on: '["#1"]' });
    assert.deepStrictEqual(blockers, [{ task_number: "#1", status: "in_progress" }]);
  });

  it("reports dependencies in intermediate workflow stages as blocking", () => {
    const db = createDb();
    insertTask(db, "d1", "#1", "refinement");
    insertTask(db, "d2", "#2", "pr_review");
    insertTask(db, "d3", "#3", "done");
    const blockers = getBlockingDependencies(db, { depends_on: '["#1","#2","#3"]' });
    assert.deepStrictEqual(blockers, [
      { task_number: "#1", status: "refinement" },
      { task_number: "#2", status: "pr_review" },
    ]);
  });

  it("treats an unknown task_number as blocking (not silently passing)", () => {
    const db = createDb();
    const blockers = getBlockingDependencies(db, { depends_on: '["#missing"]' });
    assert.deepStrictEqual(blockers, [{ task_number: "#missing", status: "unknown" }]);
  });

  it("treats cancelled dependencies as still blocking", () => {
    // Open question in the original design; we block to be conservative
    // — a cancelled task may have edited files mid-way and never merged.
    const db = createDb();
    insertTask(db, "d1", "#1", "cancelled");
    const blockers = getBlockingDependencies(db, { depends_on: '["#1"]' });
    assert.deepStrictEqual(blockers, [{ task_number: "#1", status: "cancelled" }]);
  });
});

describe("hasBlockingDependencies", () => {
  it("returns true when at least one dep is not done", () => {
    const db = createDb();
    insertTask(db, "d1", "#1", "in_progress");
    assert.equal(hasBlockingDependencies(db, { depends_on: '["#1"]' }), true);
  });

  it("returns false when all deps are done", () => {
    const db = createDb();
    insertTask(db, "d1", "#1", "done");
    assert.equal(hasBlockingDependencies(db, { depends_on: '["#1"]' }), false);
  });
});

describe("formatBlockingDependencies", () => {
  it("formats an empty list as empty string", () => {
    assert.equal(formatBlockingDependencies([]), "");
  });

  it("joins multiple blockers with ', '", () => {
    assert.equal(
      formatBlockingDependencies([
        { task_number: "#1", status: "in_progress" },
        { task_number: "#2", status: "refinement" },
      ]),
      "#1 (in_progress), #2 (refinement)",
    );
  });
});
