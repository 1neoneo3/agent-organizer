import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.js";

describe("task schema review artifact fields", () => {
  it("includes review artifact and external tracking columns", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ao-db-")), "test.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_SQL);

    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((col) => col.name));

    assert.equal(names.has("external_source"), true);
    assert.equal(names.has("external_id"), true);
    assert.equal(names.has("review_branch"), true);
    assert.equal(names.has("review_commit_sha"), true);
    assert.equal(names.has("review_sync_status"), true);
    assert.equal(names.has("review_sync_error"), true);
  });
});
