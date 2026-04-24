import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isValidSequentialTaskNumber,
  nextTaskNumber,
  isUuidLikeTitle,
} from "./task-number.js";

describe("isValidSequentialTaskNumber", () => {
  it("accepts #1", () => {
    assert.equal(isValidSequentialTaskNumber("#1"), true);
  });

  it("accepts #477", () => {
    assert.equal(isValidSequentialTaskNumber("#477"), true);
  });

  it("accepts #0", () => {
    assert.equal(isValidSequentialTaskNumber("#0"), true);
  });

  it("rejects hex fragment #40b0c5", () => {
    assert.equal(isValidSequentialTaskNumber("#40b0c5"), false);
  });

  it("rejects leading-zero UUID prefix #082098", () => {
    assert.equal(isValidSequentialTaskNumber("#082098"), false);
  });

  it("rejects empty string", () => {
    assert.equal(isValidSequentialTaskNumber(""), false);
  });

  it("rejects bare #", () => {
    assert.equal(isValidSequentialTaskNumber("#"), false);
  });

  it("rejects decomposer format T01", () => {
    assert.equal(isValidSequentialTaskNumber("T01"), false);
  });

  it("rejects leading zero #01", () => {
    assert.equal(isValidSequentialTaskNumber("#01"), false);
  });

  it("rejects #00", () => {
    assert.equal(isValidSequentialTaskNumber("#00"), false);
  });
});

describe("isUuidLikeTitle", () => {
  it("detects Task <uuid>", () => {
    assert.equal(
      isUuidLikeTitle("Task 40b0c57e-1234-5678-9abc-def012345678"),
      true,
    );
  });

  it("allows normal titles", () => {
    assert.equal(isUuidLikeTitle("Fix authentication bug"), false);
  });

  it("allows titles starting with Task", () => {
    assert.equal(isUuidLikeTitle("Task for authentication module"), false);
  });
});

describe("nextTaskNumber (with DB)", () => {
  const DB_PATH = join(
    tmpdir(),
    `ao-task-number-${process.pid}-${Date.now()}.db`,
  );
  let db: DatabaseSync;

  before(() => {
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        task_number TEXT
      )
    `);
  });

  after(() => {
    db.close();
    rmSync(DB_PATH, { force: true });
  });

  it("returns #1 for an empty table", () => {
    assert.equal(nextTaskNumber(db), "#1");
  });

  it("increments from the highest valid number", () => {
    db.exec("INSERT INTO tasks (id, task_number) VALUES ('a', '#5')");
    assert.equal(nextTaskNumber(db), "#6");
  });

  it("ignores hex fragment #40b0c5", () => {
    db.exec(
      "INSERT INTO tasks (id, task_number) VALUES ('b', '#40b0c5')",
    );
    assert.equal(nextTaskNumber(db), "#6");
  });

  it("ignores leading-zero UUID prefix #082098", () => {
    db.exec(
      "INSERT INTO tasks (id, task_number) VALUES ('c', '#082098')",
    );
    assert.equal(nextTaskNumber(db), "#6");
  });

  it("ignores decomposer T-format task numbers", () => {
    db.exec("INSERT INTO tasks (id, task_number) VALUES ('d', 'T01')");
    assert.equal(nextTaskNumber(db), "#6");
  });

  it("increments correctly after valid insert", () => {
    db.exec("INSERT INTO tasks (id, task_number) VALUES ('e', '#477')");
    assert.equal(nextTaskNumber(db), "#478");
  });
});
