import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTerminalStatus, isAutoStage, shouldStampCompletedAt } from "./task-rules.js";
import { TASK_STATUSES, WORKFLOW_STAGES } from "./task-status.js";

describe("TASK_STATUSES includes logic", () => {
  it("contains the logic status", () => {
    assert.ok(TASK_STATUSES.includes("logic"), "logic should be in TASK_STATUSES");
  });

  it("places logic after in_progress", () => {
    const inProgressIndex = TASK_STATUSES.indexOf("in_progress");
    const logicIndex = TASK_STATUSES.indexOf("logic");
    assert.ok(logicIndex > inProgressIndex, "logic should come after in_progress");
  });
});

describe("WORKFLOW_STAGES includes logic", () => {
  it("contains the logic stage", () => {
    assert.ok(WORKFLOW_STAGES.includes("logic"), "logic should be in WORKFLOW_STAGES");
  });

  it("places logic between in_progress and test_generation", () => {
    const inProgressIndex = WORKFLOW_STAGES.indexOf("in_progress");
    const logicIndex = WORKFLOW_STAGES.indexOf("logic");
    const testGenIndex = WORKFLOW_STAGES.indexOf("test_generation");
    assert.ok(logicIndex > inProgressIndex);
    assert.ok(logicIndex < testGenIndex);
  });
});

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

  it("is false for logic", () => {
    assert.equal(isTerminalStatus("logic"), false);
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

  it("is true for pre_deploy", () => {
    assert.equal(isAutoStage("pre_deploy"), true);
  });

  it("is false for human_review (terminal for auto flow)", () => {
    assert.equal(isAutoStage("human_review"), false);
  });

  it("is false for in_progress", () => {
    assert.equal(isAutoStage("in_progress"), false);
  });

  it("is false for logic (logic is manual, not auto)", () => {
    assert.equal(isAutoStage("logic"), false);
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

  it("does not stamp for pre_deploy", () => {
    assert.equal(shouldStampCompletedAt("pre_deploy"), false);
  });
});
