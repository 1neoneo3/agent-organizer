import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTerminalStatus, isAutoStage, shouldStampCompletedAt } from "./task-rules.js";

describe("isTerminalStatus", () => {
  it("is true for done", () => {
    assert.equal(isTerminalStatus("done"), true);
  });

  it("is true for cancelled", () => {
    assert.equal(isTerminalStatus("cancelled"), true);
  });

  it("is false for in_progress", () => {
    assert.equal(isTerminalStatus("in_progress"), false);
  });

  it("is false for human_review", () => {
    assert.equal(isTerminalStatus("human_review"), false);
  });

  it("is false for inbox", () => {
    assert.equal(isTerminalStatus("inbox"), false);
  });
});

describe("isAutoStage", () => {
  it("is true for pr_review", () => {
    assert.equal(isAutoStage("pr_review"), true);
  });

  it("is true for qa_testing", () => {
    assert.equal(isAutoStage("qa_testing"), true);
  });

  it("is true for test_generation", () => {
    assert.equal(isAutoStage("test_generation"), true);
  });

  it("is false for human_review (terminal for auto flow)", () => {
    assert.equal(isAutoStage("human_review"), false);
  });

  it("is false for in_progress", () => {
    assert.equal(isAutoStage("in_progress"), false);
  });
});

describe("shouldStampCompletedAt", () => {
  it("stamps for done", () => {
    assert.equal(shouldStampCompletedAt("done"), true);
  });

  it("stamps for cancelled", () => {
    assert.equal(shouldStampCompletedAt("cancelled"), true);
  });

  it("does not stamp for human_review", () => {
    assert.equal(shouldStampCompletedAt("human_review"), false);
  });

});
