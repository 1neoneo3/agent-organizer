import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractPlannedFilesFromPlan,
  intersectFilePaths,
  normalizePath,
  parsePlannedFiles,
} from "./planned-files.js";

describe("normalizePath", () => {
  it("strips a leading ./ so both forms collide", () => {
    assert.equal(normalizePath("./src/a.ts"), "src/a.ts");
  });

  it("strips a trailing slash on directory paths", () => {
    assert.equal(normalizePath("src/auth/"), "src/auth");
  });

  it("collapses duplicate slashes", () => {
    assert.equal(normalizePath("src//a.ts"), "src/a.ts");
  });

  it("leaves a bare slash alone (root marker)", () => {
    assert.equal(normalizePath("/"), "/");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normalizePath("  src/a.ts  "), "src/a.ts");
  });

  it("is idempotent", () => {
    const once = normalizePath("./src//auth/");
    assert.equal(normalizePath(once), once);
  });
});

describe("extractPlannedFilesFromPlan", () => {
  it("returns [] for null / empty input", () => {
    assert.deepStrictEqual(extractPlannedFilesFromPlan(null), []);
    assert.deepStrictEqual(extractPlannedFilesFromPlan(""), []);
  });

  it("returns [] when the plan has no Files to Modify heading", () => {
    const plan = "## Background\n\nSome prose about the task.\n";
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), []);
  });

  it("extracts backtick-wrapped paths from bullet lines under the EN heading", () => {
    const plan = [
      "## Background",
      "",
      "blah",
      "",
      "## Files to Modify",
      "",
      "- `src/auth.ts` — add middleware",
      "- `src/new-file.ts` — (new file) purpose",
      "",
      "## Implementation Plan",
      "1. do X",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), [
      "src/auth.ts",
      "src/new-file.ts",
    ]);
  });

  it("extracts under the JA heading 修正するファイル", () => {
    const plan = [
      "## 修正するファイル",
      "",
      "- `server/routes/tasks.ts` — 追加",
      "- `server/domain/task-dependencies.ts` — 新規",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), [
      "server/routes/tasks.ts",
      "server/domain/task-dependencies.ts",
    ]);
  });

  it("stops at the next heading and ignores subsequent sections", () => {
    const plan = [
      "## Files to Modify",
      "",
      "- `a.ts` — x",
      "",
      "## Implementation Plan",
      "",
      "- `b.ts` — should NOT be picked up (different section)",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), ["a.ts"]);
  });

  it("deduplicates and preserves first-occurrence order", () => {
    const plan = [
      "## Files to Modify",
      "",
      "- `a.ts` — x",
      "- `./a.ts` — dup with different formatting",
      "- `b.ts` — x",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), ["a.ts", "b.ts"]);
  });

  it("ignores bullet lines that don't have a backtick path", () => {
    const plan = [
      "## Files to Modify",
      "",
      "- just prose without any path",
      "- `kept.ts` — has path",
      "- another prose line",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), ["kept.ts"]);
  });

  it("handles ### (sub-heading) level too", () => {
    const plan = [
      "### Files to Modify",
      "",
      "- `a.ts` — x",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), ["a.ts"]);
  });

  it("extracts under the JA heading 変更対象ファイル", () => {
    // The JA refinement prompt in prompt-builder.ts uses 変更対象ファイル.
    // Without this entry, every JA-language refinement plan was returning
    // [] from the extractor, and the file-conflict gate stayed silent.
    const plan = [
      "## 変更対象ファイル",
      "",
      "- `server/routes/tasks.ts` — handler 拡張",
      "- `server/domain/task-rules.ts` — 新規ヘルパー",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), [
      "server/routes/tasks.ts",
      "server/domain/task-rules.ts",
    ]);
  });

  it("accepts a parenthesized bilingual annotation after the heading", () => {
    // Refinement plans authored by JA agents commonly include a bilingual
    // hint, e.g. `## 変更対象ファイル (Files to Modify)`. The strict
    // `\\s*$` form rejected these and lost the planned_files data.
    const plan = [
      "## 変更対象ファイル (Files to Modify)",
      "",
      "- `src/a.ts` — x",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), ["src/a.ts"]);
  });

  it("accepts a parenthesized status note like `(planned)` after the heading", () => {
    const plan = [
      "## Files to Modify (planned)",
      "",
      "- `src/a.ts` — x",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), ["src/a.ts"]);
  });

  it("does NOT match `## Files to Modify Backup` (extra trailing word, no parens)", () => {
    // False-positive guard: a section called "Files to Modify Backup" is
    // not the planned-files section. Treating it as one would route stale
    // backup paths into the file-conflict gate.
    const plan = [
      "## Files to Modify Backup",
      "",
      "- `src/old-backup.ts` — historical",
      "",
      "## Files to Modify",
      "",
      "- `src/active.ts` — current target",
    ].join("\n");
    assert.deepStrictEqual(
      extractPlannedFilesFromPlan(plan),
      ["src/active.ts"],
      "must skip the Backup section and only pick the canonical heading",
    );
  });

  it("does NOT match `## Files to Modify Or Skip`", () => {
    const plan = [
      "## Files to Modify Or Skip",
      "",
      "- `src/maybe.ts` — undecided",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), []);
  });

  it("does NOT match a heading with a trailing word AFTER the parenthesized annotation", () => {
    const plan = [
      "## Files to Modify (planned) Backup",
      "",
      "- `src/should-not-leak.ts` — x",
    ].join("\n");
    assert.deepStrictEqual(extractPlannedFilesFromPlan(plan), []);
  });
});

describe("parsePlannedFiles", () => {
  it("returns [] for null", () => {
    assert.deepStrictEqual(parsePlannedFiles(null), []);
  });

  it("returns [] for malformed JSON", () => {
    assert.deepStrictEqual(parsePlannedFiles("not json"), []);
  });

  it("returns [] for non-array JSON", () => {
    assert.deepStrictEqual(parsePlannedFiles('{"a":"b"}'), []);
  });

  it("filters non-string elements out", () => {
    assert.deepStrictEqual(parsePlannedFiles('["a.ts",42,null,"b.ts"]'), ["a.ts", "b.ts"]);
  });

  it("round-trips an array", () => {
    const value = ["src/a.ts", "src/b.ts"];
    assert.deepStrictEqual(parsePlannedFiles(JSON.stringify(value)), value);
  });

  it("defensively normalizes entries that were not normalized at write time", () => {
    // Guard for future write paths (admin API, SQL console backfill, etc.)
    // that might persist raw strings. intersectFilePaths compares with
    // strict Set equality, so without normalize-at-read a "./src/a.ts"
    // row and a "src/a.ts" row would silently miss each other.
    assert.deepStrictEqual(
      parsePlannedFiles('["./src/a.ts","src/b.ts/","src//c.ts"]'),
      ["src/a.ts", "src/b.ts", "src/c.ts"],
    );
  });

  it("deduplicates entries that normalize to the same path", () => {
    assert.deepStrictEqual(
      parsePlannedFiles('["src/a.ts","./src/a.ts","src//a.ts"]'),
      ["src/a.ts"],
    );
  });
});

describe("intersectFilePaths", () => {
  it("returns [] when either side is empty", () => {
    assert.deepStrictEqual(intersectFilePaths([], ["a"]), []);
    assert.deepStrictEqual(intersectFilePaths(["a"], []), []);
  });

  it("returns a sorted list of overlapping paths", () => {
    const a = ["src/auth.ts", "src/middleware.ts", "README.md"];
    const b = ["README.md", "src/middleware.ts", "unrelated.ts"];
    assert.deepStrictEqual(intersectFilePaths(a, b), ["README.md", "src/middleware.ts"]);
  });

  it("deduplicates overlaps", () => {
    const a = ["a.ts", "a.ts", "b.ts"];
    const b = ["a.ts", "b.ts"];
    assert.deepStrictEqual(intersectFilePaths(a, b), ["a.ts", "b.ts"]);
  });
});
