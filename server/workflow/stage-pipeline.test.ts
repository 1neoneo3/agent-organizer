import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveActiveStages, nextStage } from "./stage-pipeline.js";
import type { ProjectWorkflow } from "./loader.js";

// Minimal mock DB that returns settings
function createMockDb(settings: Record<string, string>) {
  return {
    prepare: (sql: string) => ({
      get: (key: string) => {
        if (sql.includes("settings")) {
          return settings[key] ? { value: settings[key] } : undefined;
        }
        return undefined;
      },
      all: () => [],
      run: () => {},
    }),
    exec: () => {},
  } as any;
}

const baseWorkflow: ProjectWorkflow = {
  body: "",
  codexSandboxMode: "workspace-write",
  codexApprovalPolicy: "on-request",
  e2eExecution: "host",
  e2eCommand: null,
  gitWorkflow: "default",
  workspaceMode: "shared",
  branchPrefix: "ao",
  beforeRun: [],
  afterRun: [],
  formatCommand: null,
  includeTask: true,
  includeReview: true,
  includeDecompose: true,
  enableTestGeneration: false,
  enableHumanReview: false,
  enablePreDeploy: false,
};

describe("resolveActiveStages", () => {
  it("returns minimal pipeline when all disabled", () => {
    const db = createMockDb({ qa_mode: "disabled", review_mode: "none" });
    const stages = resolveActiveStages(db, { ...baseWorkflow });
    assert.deepStrictEqual(stages, ["in_progress", "done"]);
  });

  it("includes qa_testing when qa_mode enabled", () => {
    const db = createMockDb({ qa_mode: "enabled", review_mode: "none" });
    const stages = resolveActiveStages(db, { ...baseWorkflow });
    assert.deepStrictEqual(stages, ["in_progress", "qa_testing", "done"]);
  });

  it("includes pr_review when review_mode is pr_only", () => {
    const db = createMockDb({ qa_mode: "disabled", review_mode: "pr_only" });
    const stages = resolveActiveStages(db, { ...baseWorkflow });
    assert.deepStrictEqual(stages, ["in_progress", "pr_review", "done"]);
  });

  it("includes all stages when everything enabled", () => {
    const db = createMockDb({ qa_mode: "enabled", review_mode: "pr_only" });
    const workflow = {
      ...baseWorkflow,
      enableTestGeneration: true,
      enableHumanReview: true,
      enablePreDeploy: true,
    };
    const stages = resolveActiveStages(db, workflow);
    assert.deepStrictEqual(stages, [
      "in_progress",
      "test_generation",
      "qa_testing",
      "pr_review",
      "human_review",
      "pre_deploy",
      "done",
    ]);
  });

  it("skips test_generation when disabled but includes human_review", () => {
    const db = createMockDb({ qa_mode: "disabled", review_mode: "pr_only" });
    const workflow = {
      ...baseWorkflow,
      enableTestGeneration: false,
      enableHumanReview: true,
      enablePreDeploy: false,
    };
    const stages = resolveActiveStages(db, workflow);
    assert.deepStrictEqual(stages, [
      "in_progress",
      "pr_review",
      "human_review",
      "done",
    ]);
  });

  it("uses defaults when workflow is null", () => {
    const db = createMockDb({ qa_mode: "disabled", review_mode: "pr_only" });
    const stages = resolveActiveStages(db, null);
    assert.deepStrictEqual(stages, ["in_progress", "pr_review", "done"]);
  });
});

describe("nextStage", () => {
  it("advances to next active stage", () => {
    const stages = ["in_progress", "qa_testing", "pr_review", "done"] as any;
    assert.strictEqual(nextStage("in_progress", stages), "qa_testing");
    assert.strictEqual(nextStage("qa_testing", stages), "pr_review");
    assert.strictEqual(nextStage("pr_review", stages), "done");
  });

  it("returns done for last stage", () => {
    const stages = ["in_progress", "done"] as any;
    assert.strictEqual(nextStage("in_progress", stages), "done");
  });

  it("returns done for unknown stage", () => {
    const stages = ["in_progress", "done"] as any;
    assert.strictEqual(nextStage("qa_testing", stages), "done");
  });

  it("skips disabled stages correctly", () => {
    // qa_testing disabled, goes from in_progress directly to pr_review
    const stages = ["in_progress", "pr_review", "human_review", "done"] as any;
    assert.strictEqual(nextStage("in_progress", stages), "pr_review");
    assert.strictEqual(nextStage("pr_review", stages), "human_review");
    assert.strictEqual(nextStage("human_review", stages), "done");
  });
});
