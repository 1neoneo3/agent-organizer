import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import {
  getTaskSetting,
  mergeOverrides,
  safeParseOverrides,
  TASK_OVERRIDABLE_KEYS,
  validateOverridesPatch,
} from "./task-settings.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function insertTask(db: DatabaseSync, id: string, overrides: Record<string, string> | null): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, task_size, settings_overrides) VALUES (?, ?, 'inbox', 'small', ?)",
  ).run(id, `task ${id}`, overrides ? JSON.stringify(overrides) : null);
}

describe("validateOverridesPatch", () => {
  it("treats undefined as a no-op", () => {
    const r = validateOverridesPatch(undefined);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.patch, undefined);
  });

  it("accepts a patch whose keys are all in TASK_OVERRIDABLE_KEYS", () => {
    const r = validateOverridesPatch({
      default_enable_refinement: "false",
      review_mode: "none",
    });
    assert.equal(r.ok, true);
  });

  it("accepts `null` values (used to delete a key in mergeOverrides)", () => {
    const r = validateOverridesPatch({ default_enable_refinement: null });
    assert.equal(r.ok, true);
  });

  it("rejects unknown keys with the exact offending list", () => {
    const r = validateOverridesPatch({
      default_enable_refinement: "false", // valid
      enable_refinement: "false",          // typo — must be flagged
      "random.garbage": "x",               // obviously invalid
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepStrictEqual(r.invalidKeys.sort(), ["enable_refinement", "random.garbage"].sort());
    }
  });

  it("every declared overridable key passes validation (round-trip sanity)", () => {
    // Guards against a future edit that adds a key to the allow-list
    // without updating the validator — they use the same source of
    // truth, so this test just confirms they stay in sync.
    const patch = Object.fromEntries(TASK_OVERRIDABLE_KEYS.map((k) => [k, "x"]));
    const r = validateOverridesPatch(patch);
    assert.equal(r.ok, true);
  });
});

describe("getTaskSetting — task override precedence", () => {
  it("returns the task-level override when one is set for this key", () => {
    const db = createDb();
    // global default is "true"
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "default_enable_refinement",
      "true",
    );
    insertTask(db, "t1", { default_enable_refinement: "false" });
    assert.equal(getTaskSetting(db, "default_enable_refinement", "t1"), "false");
  });

  it("falls back to the global setting when the task has no override for this key", () => {
    const db = createDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "default_enable_refinement",
      "true",
    );
    insertTask(db, "t1", { review_mode: "none" }); // unrelated override
    assert.equal(getTaskSetting(db, "default_enable_refinement", "t1"), "true");
  });

  it("returns undefined when neither task nor global defines the key", () => {
    const db = createDb();
    insertTask(db, "t1", null);
    assert.equal(getTaskSetting(db, "some_unset_key", "t1"), undefined);
  });

  it("ignores task overrides when taskId is not provided (global-only mode)", () => {
    const db = createDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "default_enable_refinement",
      "true",
    );
    insertTask(db, "t1", { default_enable_refinement: "false" });
    assert.equal(getTaskSetting(db, "default_enable_refinement", undefined), "true");
  });
});

describe("safeParseOverrides", () => {
  it("returns null for malformed JSON (silent fallback — see doc comment)", () => {
    assert.equal(safeParseOverrides("not json"), null);
  });

  it("returns null for an array (callers expect a record, not a list)", () => {
    assert.equal(safeParseOverrides("[1,2,3]"), null);
  });

  it("filters out non-string values rather than rejecting the whole payload", () => {
    // Non-string values are dropped so a single corrupt entry cannot
    // blow away every valid override alongside it.
    assert.deepStrictEqual(
      safeParseOverrides('{"review_mode":"none","qa_count":42,"auto_qa":"false"}'),
      { review_mode: "none", auto_qa: "false" },
    );
  });
});

describe("mergeOverrides", () => {
  it("merges a patch into an existing blob", () => {
    assert.deepStrictEqual(
      mergeOverrides('{"review_mode":"none"}', { auto_qa: "false" }),
      { review_mode: "none", auto_qa: "false" },
    );
  });

  it("null in the patch deletes the key", () => {
    assert.deepStrictEqual(
      mergeOverrides('{"review_mode":"none","auto_qa":"false"}', { review_mode: null }),
      { auto_qa: "false" },
    );
  });

  it("returns null when the merged result is empty (so the column is cleared)", () => {
    assert.equal(
      mergeOverrides('{"review_mode":"none"}', { review_mode: null }),
      null,
    );
  });
});
