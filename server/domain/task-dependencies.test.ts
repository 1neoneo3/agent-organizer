import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import {
  collectAllBlockers,
  formatAllBlockers,
  formatBlockingDependencies,
  formatFileConflicts,
  getBlockingDependencies,
  getFileConflicts,
  hasBlockingDependencies,
  isBlocked,
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
  directiveId: string | null = null,
): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, task_size, task_number, directive_id) VALUES (?, ?, ?, 'small', ?, ?)",
  ).run(id, `task ${taskNumber}`, status, taskNumber, directiveId);
}

function insertTaskWithPlannedFiles(
  db: DatabaseSync,
  id: string,
  taskNumber: string,
  status: string,
  plannedFiles: string[],
): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, task_size, task_number, planned_files) VALUES (?, ?, ?, 'small', ?, ?)",
  ).run(id, `task ${taskNumber}`, status, taskNumber, JSON.stringify(plannedFiles));
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

  it("scopes task_number dependencies by directive_id when present", () => {
    const db = createDb();
    db.prepare(
      "INSERT INTO directives (id, title, content, status) VALUES (?, ?, ?, 'active')",
    ).run("d-a", "A", "A");
    db.prepare(
      "INSERT INTO directives (id, title, content, status) VALUES (?, ?, ?, 'active')",
    ).run("d-b", "B", "B");
    insertTask(db, "a1", "T01", "done", "d-a");
    insertTask(db, "b1", "T01", "in_progress", "d-b");

    const blockers = getBlockingDependencies(db, {
      directive_id: "d-a",
      depends_on: '["T01"]',
    });

    assert.deepStrictEqual(blockers, []);
  });

  it("does not pass a dependency because a different directive has the same done task_number", () => {
    const db = createDb();
    db.prepare(
      "INSERT INTO directives (id, title, content, status) VALUES (?, ?, ?, 'active')",
    ).run("d-a", "A", "A");
    db.prepare(
      "INSERT INTO directives (id, title, content, status) VALUES (?, ?, ?, 'active')",
    ).run("d-b", "B", "B");
    insertTask(db, "a1", "T01", "done", "d-a");
    insertTask(db, "b1", "T01", "in_progress", "d-b");

    const blockers = getBlockingDependencies(db, {
      directive_id: "d-b",
      depends_on: '["T01"]',
    });

    assert.deepStrictEqual(blockers, [{ task_number: "T01", status: "in_progress" }]);
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

describe("getFileConflicts", () => {
  it("returns [] when the task has no planned_files", () => {
    const db = createDb();
    insertTaskWithPlannedFiles(db, "busy", "#1", "in_progress", ["src/a.ts"]);
    const conflicts = getFileConflicts(db, { id: "tme", planned_files: null });
    assert.deepStrictEqual(conflicts, []);
  });

  it("returns [] when no other active task shares any file", () => {
    const db = createDb();
    insertTaskWithPlannedFiles(db, "busy", "#1", "in_progress", ["src/other.ts"]);
    const conflicts = getFileConflicts(db, {
      id: "tme",
      planned_files: JSON.stringify(["src/mine.ts"]),
    });
    assert.deepStrictEqual(conflicts, []);
  });

  it("reports overlap with an in_progress task (the primary use case)", () => {
    const db = createDb();
    insertTaskWithPlannedFiles(db, "busy", "#1", "in_progress", [
      "src/auth.ts",
      "src/middleware.ts",
    ]);
    const conflicts = getFileConflicts(db, {
      id: "tme",
      planned_files: JSON.stringify(["src/auth.ts", "docs/api.md"]),
    });
    assert.deepStrictEqual(conflicts, [
      { task_number: "#1", status: "in_progress", overlapping_files: ["src/auth.ts"] },
    ]);
  });

  it("reports overlap against every active editing stage, not only in_progress", () => {
    const db = createDb();
    insertTaskWithPlannedFiles(db, "a", "#1", "refinement", ["src/a.ts"]);
    insertTaskWithPlannedFiles(db, "b", "#2", "pr_review", ["src/a.ts"]);
    insertTaskWithPlannedFiles(db, "c", "#3", "done", ["src/a.ts"]); // must be ignored
    insertTaskWithPlannedFiles(db, "d", "#4", "cancelled", ["src/a.ts"]); // must be ignored
    const conflicts = getFileConflicts(db, {
      id: "tme",
      planned_files: JSON.stringify(["src/a.ts"]),
    });
    const numbers = conflicts.map((c) => c.task_number).sort();
    assert.deepStrictEqual(numbers, ["#1", "#2"]);
  });

  it("does NOT report the task itself as conflicting", () => {
    const db = createDb();
    db.prepare(
      "INSERT INTO tasks (id, title, status, task_size, task_number, planned_files) VALUES (?, ?, ?, 'small', ?, ?)",
    ).run("self", "me", "in_progress", "#1", JSON.stringify(["src/a.ts"]));
    const conflicts = getFileConflicts(db, {
      id: "self",
      planned_files: JSON.stringify(["src/a.ts"]),
    });
    assert.deepStrictEqual(conflicts, []);
  });

  it("skips tasks whose planned_files is null (unknown static footprint)", () => {
    const db = createDb();
    // Another task is in_progress but has no planned_files metadata —
    // we can't prove conflict, so we must not claim one.
    insertTask(db, "busy", "#1", "in_progress");
    const conflicts = getFileConflicts(db, {
      id: "tme",
      planned_files: JSON.stringify(["src/a.ts"]),
    });
    assert.deepStrictEqual(conflicts, []);
  });
});

describe("collectAllBlockers + isBlocked", () => {
  it("combines depends_on and file-conflict blockers", () => {
    const db = createDb();
    insertTask(db, "dep", "#1", "in_progress");
    insertTaskWithPlannedFiles(db, "ov", "#2", "in_progress", ["src/a.ts"]);
    const blockers = collectAllBlockers(db, {
      id: "tme",
      depends_on: '["#1"]',
      planned_files: JSON.stringify(["src/a.ts"]),
    });
    assert.equal(blockers.dependencies.length, 1);
    assert.equal(blockers.fileConflicts.length, 1);
    assert.equal(isBlocked(blockers), true);
  });

  it("isBlocked is false when both lists are empty", () => {
    const db = createDb();
    const blockers = collectAllBlockers(db, {
      id: "tme",
      depends_on: null,
      planned_files: null,
    });
    assert.equal(isBlocked(blockers), false);
  });
});

describe("formatFileConflicts + formatAllBlockers", () => {
  it("formats a single conflict with its overlapping files", () => {
    assert.equal(
      formatFileConflicts([
        {
          task_number: "#12",
          status: "in_progress",
          overlapping_files: ["src/auth.ts", "src/middleware.ts"],
        },
      ]),
      "#12 (in_progress) → src/auth.ts, src/middleware.ts",
    );
  });

  it("formatAllBlockers labels each category", () => {
    const rendered = formatAllBlockers({
      dependencies: [{ task_number: "#1", status: "in_progress" }],
      fileConflicts: [
        {
          task_number: "#2",
          status: "refinement",
          overlapping_files: ["src/a.ts"],
        },
      ],
    });
    assert.match(rendered, /depends_on: #1 \(in_progress\)/);
    assert.match(rendered, /file conflicts: #2 \(refinement\) → src\/a\.ts/);
  });

  it("formatAllBlockers renders only the non-empty category", () => {
    const rendered = formatAllBlockers({
      dependencies: [{ task_number: "#1", status: "in_progress" }],
      fileConflicts: [],
    });
    assert.equal(rendered, "depends_on: #1 (in_progress)");
  });
});
