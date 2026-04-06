import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveActiveStages, nextStage, findLastFailedStage, recordFailedStage, clearFailedStage, validateStatusTransition } from "./stage-pipeline.js";
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
          projectType: "generic" as const,
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
          projectType: "generic" as const,
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

describe("findLastFailedStage / recordFailedStage / clearFailedStage", () => {
  function createMockDbWithLogs(logs: Array<{ message: string }>) {
    return {
      prepare: (sql: string) => ({
        get: () => {
          if (sql.includes("FAIL_AT")) {
            // Return last FAIL_AT log that isn't CLEARED
            const failLogs = logs.filter(l => l.message.includes("[FAIL_AT:") && !l.message.includes("CLEARED"));
            return failLogs.length > 0 ? failLogs[failLogs.length - 1] : undefined;
          }
          return undefined;
        },
        all: () => [],
        run: (...args: any[]) => { logs.push({ message: args[1] }); },
      }),
      exec: () => {},
    } as any;
  }

  it("returns null when no failure marker exists", () => {
    const db = createMockDbWithLogs([]);
    assert.strictEqual(findLastFailedStage(db, "task-1"), null);
  });

  it("returns the failed stage from marker", () => {
    const db = createMockDbWithLogs([
      { message: "[FAIL_AT:qa_testing] Stage failed. Task will resume from this stage after rework." },
    ]);
    assert.strictEqual(findLastFailedStage(db, "task-1"), "qa_testing");
  });

  it("records a failure marker", () => {
    const logs: Array<{ message: string }> = [];
    const db = createMockDbWithLogs(logs);
    recordFailedStage(db, "task-1", "pr_review");
    assert.ok(logs.some(l => l.message.includes("[FAIL_AT:pr_review]")));
  });

  it("clears a failure marker", () => {
    const logs: Array<{ message: string }> = [];
    const db = createMockDbWithLogs(logs);
    clearFailedStage(db, "task-1");
    assert.ok(logs.some(l => l.message.includes("[FAIL_AT:CLEARED]")));
  });
});

describe("validateStatusTransition", () => {
  it("allows inbox → in_progress", () => {
    const db = createMockDb({ qa_mode: "enabled", review_mode: "pr_only" });
    assert.strictEqual(validateStatusTransition(db, "inbox", "in_progress", baseWorkflow), null);
  });

  it("allows any → inbox (reset)", () => {
    const db = createMockDb({ qa_mode: "enabled", review_mode: "pr_only" });
    assert.strictEqual(validateStatusTransition(db, "pr_review", "inbox", baseWorkflow), null);
  });

  it("allows any → cancelled", () => {
    const db = createMockDb({ qa_mode: "enabled", review_mode: "pr_only" });
    assert.strictEqual(validateStatusTransition(db, "in_progress", "cancelled", baseWorkflow), null);
  });

  it("allows forward to immediate next stage", () => {
    const db = createMockDb({ qa_mode: "enabled", review_mode: "pr_only" });
    assert.strictEqual(validateStatusTransition(db, "in_progress", "qa_testing", baseWorkflow), null);
  });

  it("rejects skipping stages", () => {
    const db = createMockDb({ qa_mode: "enabled", review_mode: "pr_only" });
    const result = validateStatusTransition(db, "in_progress", "pr_review", baseWorkflow);
    assert.ok(result);
    assert.ok(result.includes("Cannot skip"));
  });

  it("rejects backward transitions", () => {
    const db = createMockDb({ qa_mode: "enabled", review_mode: "pr_only" });
    const result = validateStatusTransition(db, "pr_review", "in_progress", baseWorkflow);
    assert.ok(result);
    assert.ok(result.includes("Cannot move backward"));
  });

  it("rejects jumping to done directly", () => {
    const db = createMockDb({ qa_mode: "enabled", review_mode: "pr_only" });
    const result = validateStatusTransition(db, "in_progress", "done", baseWorkflow);
    assert.ok(result);
    assert.ok(result.includes("Cannot skip"));
  });
});
