import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveActiveStages,
  nextStage,
  findLastFailedStage,
  recordFailedStage,
  clearFailedStage,
  validateStatusTransition,
  aggregateCheckResults,
  resolveCheckVerdictForTask,
  determineNextStage,
} from "./stage-pipeline.js";
import type { ProjectWorkflow } from "./loader.js";
import {
  __clearLatestCheckResultsForTest,
  __setLatestCheckResultsForTest,
  type CheckResult,
} from "../spawner/auto-checks.js";
import type { Task } from "../types/runtime.js";

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
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
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
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
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

  // --- Global default settings fallback ---

  it("falls back to default_enable_test_generation setting when workflow is null", () => {
    const db = createMockDb({
      qa_mode: "disabled",
      review_mode: "none",
      default_enable_test_generation: "true",
    });
    const stages = resolveActiveStages(db, null, "medium");
    assert.deepStrictEqual(stages, ["in_progress", "test_generation", "done"]);
  });

  it("skips test_generation for small tasks even when global default is enabled", () => {
    const db = createMockDb({
      qa_mode: "disabled",
      review_mode: "none",
      default_enable_test_generation: "true",
    });
    const stages = resolveActiveStages(db, null, "small");
    assert.deepStrictEqual(stages, ["in_progress", "done"]);
  });

  it("falls back to default_enable_human_review setting when workflow is null", () => {
    const db = createMockDb({
      qa_mode: "disabled",
      review_mode: "none",
      default_enable_human_review: "true",
    });
    const stages = resolveActiveStages(db, null);
    assert.deepStrictEqual(stages, ["in_progress", "human_review", "done"]);
  });

  it("falls back to default_enable_pre_deploy setting when workflow is null", () => {
    const db = createMockDb({
      qa_mode: "disabled",
      review_mode: "none",
      default_enable_pre_deploy: "true",
    });
    const stages = resolveActiveStages(db, null);
    assert.deepStrictEqual(stages, ["in_progress", "pre_deploy", "done"]);
  });

  it("workflow null flag falls back to settings default", () => {
    const db = createMockDb({
      qa_mode: "disabled",
      review_mode: "none",
      default_enable_human_review: "true",
    });
    const workflow = { ...baseWorkflow, enableHumanReview: null };
    const stages = resolveActiveStages(db, workflow);
    assert.deepStrictEqual(stages, ["in_progress", "human_review", "done"]);
  });

  it("workflow explicit false wins over settings default (per-project opt-out)", () => {
    const db = createMockDb({
      qa_mode: "disabled",
      review_mode: "none",
      default_enable_human_review: "true",
    });
    const workflow = { ...baseWorkflow, enableHumanReview: false };
    const stages = resolveActiveStages(db, workflow);
    assert.deepStrictEqual(stages, ["in_progress", "done"]);
  });

  it("workflow explicit true wins over settings default=false", () => {
    const db = createMockDb({
      qa_mode: "disabled",
      review_mode: "none",
      // default_enable_human_review not set → defaults to false
    });
    const workflow = { ...baseWorkflow, enableHumanReview: true };
    const stages = resolveActiveStages(db, workflow);
    assert.deepStrictEqual(stages, ["in_progress", "human_review", "done"]);
  });

  it("unset settings default to false (fail-closed, backward compatible)", () => {
    // No default_enable_* settings set, no workflow.
    const db = createMockDb({ qa_mode: "disabled", review_mode: "none" });
    const stages = resolveActiveStages(db, null, "medium");
    assert.deepStrictEqual(stages, ["in_progress", "done"]);
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

// ---------------------------------------------------------------------------
// Auto-check verdict aggregation
// ---------------------------------------------------------------------------

describe("aggregateCheckResults", () => {
  it("returns 'none' when results are missing", () => {
    assert.strictEqual(aggregateCheckResults(undefined), "none");
    assert.strictEqual(aggregateCheckResults(null), "none");
    assert.strictEqual(aggregateCheckResults([]), "none");
  });

  it("returns 'pass' when every check succeeded", () => {
    const results: CheckResult[] = [
      { kind: "types", ok: true, durationMs: 10, output: "" },
      { kind: "lint", ok: true, durationMs: 20, output: "" },
      { kind: "tests", ok: true, durationMs: 30, output: "" },
    ];
    assert.strictEqual(aggregateCheckResults(results), "pass");
  });

  it("returns 'fail' if any single check failed", () => {
    const results: CheckResult[] = [
      { kind: "types", ok: true, durationMs: 10, output: "" },
      { kind: "lint", ok: false, durationMs: 5, output: "eslint errors" },
      { kind: "tests", ok: true, durationMs: 30, output: "" },
    ];
    assert.strictEqual(aggregateCheckResults(results), "fail");
  });
});

describe("resolveCheckVerdictForTask", () => {
  it("returns 'none' when no results have been seeded", () => {
    const taskId = "task-verdict-none";
    __clearLatestCheckResultsForTest(taskId);
    assert.strictEqual(resolveCheckVerdictForTask(taskId), "none");
  });

  it("returns 'pass' when seeded with all-ok results", () => {
    const taskId = "task-verdict-pass";
    __setLatestCheckResultsForTest(taskId, [
      { kind: "types", ok: true, durationMs: 1, output: "" },
    ]);
    try {
      assert.strictEqual(resolveCheckVerdictForTask(taskId), "pass");
    } finally {
      __clearLatestCheckResultsForTest(taskId);
    }
  });

  it("returns 'fail' when seeded with any failing result", () => {
    const taskId = "task-verdict-fail";
    __setLatestCheckResultsForTest(taskId, [
      { kind: "types", ok: true, durationMs: 1, output: "" },
      { kind: "lint", ok: false, durationMs: 1, output: "bad" },
    ]);
    try {
      assert.strictEqual(resolveCheckVerdictForTask(taskId), "fail");
    } finally {
      __clearLatestCheckResultsForTest(taskId);
    }
  });
});

// ---------------------------------------------------------------------------
// determineNextStage — integration between review verdict and check verdict
// ---------------------------------------------------------------------------

/**
 * More capable mock DB for determineNextStage tests. Supports settings
 * lookups plus read/write of task_logs so {@link recordFailedStage} and
 * the review log query can operate.
 */
function createNextStageMockDb(
  settings: Record<string, string>,
  reviewLogs: Array<{ message: string }>,
) {
  const insertedLogs: Array<{ taskId: string; message: string }> = [];
  const db = {
    insertedLogs,
    prepare(sql: string) {
      if (sql.startsWith("SELECT value FROM settings")) {
        return {
          get: (key: unknown) => {
            if (typeof key !== "string") return undefined;
            return settings[key] ? { value: settings[key] } : undefined;
          },
          all: () => [],
          run: () => {},
        };
      }
      if (
        sql.includes("SELECT message FROM task_logs") &&
        sql.includes("'assistant'")
      ) {
        return {
          get: () => undefined,
          all: () => reviewLogs,
          run: () => {},
        };
      }
      if (sql.includes("FAIL_AT")) {
        return {
          get: () => undefined,
          all: () => [],
          run: () => {},
        };
      }
      if (sql.startsWith("INSERT INTO task_logs")) {
        return {
          get: () => undefined,
          all: () => [],
          run: (taskId: unknown, message: unknown) => {
            insertedLogs.push({
              taskId: String(taskId),
              message: String(message),
            });
          },
        };
      }
      return {
        get: () => undefined,
        all: () => [],
        run: () => {},
      };
    },
    exec: () => {},
  };
  return db;
}

function makeReviewTask(id: string): Task {
  return {
    id,
    title: "test",
    description: null,
    assigned_agent_id: "agent-impl",
    project_path: null,
    status: "pr_review",
    priority: 0,
    task_size: "medium",
    task_number: null,
    depends_on: null,
    result: null,
    review_count: 1,
    directive_id: null,
    pr_url: null,
    external_source: null,
    external_id: null,
    interactive_prompt_data: null,
    review_branch: null,
    review_commit_sha: null,
    review_sync_status: "pending",
    review_sync_error: null,
    repository_url: null,
    started_at: 1000,
    completed_at: null,
    last_heartbeat_at: null,
    created_at: 0,
    updated_at: 0,
  } as Task;
}

describe("determineNextStage — pr_review gating by check verdict", () => {
  const reviewSettings = { qa_mode: "disabled", review_mode: "pr_only" };

  beforeEach(() => {
    __clearLatestCheckResultsForTest("t-review-1");
  });
  afterEach(() => {
    __clearLatestCheckResultsForTest("t-review-1");
  });

  it("advances to done when review PASSes and all checks PASS", () => {
    const db = createNextStageMockDb(reviewSettings, [
      { message: "Looks good. [REVIEW:PASS]" },
    ]);
    __setLatestCheckResultsForTest("t-review-1", [
      { kind: "types", ok: true, durationMs: 1, output: "" },
      { kind: "lint", ok: true, durationMs: 1, output: "" },
      { kind: "tests", ok: true, durationMs: 1, output: "" },
    ]);

    const task = makeReviewTask("t-review-1");
    const result = determineNextStage(
      db as never,
      task,
      false,
      true,
      baseWorkflow,
    );
    assert.strictEqual(result, "done");
  });

  it("falls back to review-only gating when no check results are present", () => {
    const db = createNextStageMockDb(reviewSettings, [
      { message: "[REVIEW:PASS]" },
    ]);
    // No seeded check results -> verdict is 'none' -> existing
    // review-only logic applies.
    const task = makeReviewTask("t-review-1");
    const result = determineNextStage(
      db as never,
      task,
      false,
      true,
      baseWorkflow,
    );
    assert.strictEqual(result, "done");
  });

  it("forces in_progress when any check FAILs, even if review PASSed", () => {
    const db = createNextStageMockDb(reviewSettings, [
      { message: "[REVIEW:PASS]" },
    ]);
    __setLatestCheckResultsForTest("t-review-1", [
      { kind: "types", ok: true, durationMs: 1, output: "" },
      { kind: "lint", ok: false, durationMs: 1, output: "eslint error" },
    ]);

    const task = makeReviewTask("t-review-1");
    const result = determineNextStage(
      db as never,
      task,
      false,
      true,
      baseWorkflow,
    );
    assert.strictEqual(result, "in_progress");

    // Must also record the failure marker so the pipeline can resume.
    assert.ok(
      db.insertedLogs.some((l) =>
        l.message.includes("[FAIL_AT:pr_review]"),
      ),
      "expected [FAIL_AT:pr_review] marker when check fails",
    );
  });

  it("forces in_progress when review says NEEDS_CHANGES regardless of checks", () => {
    const db = createNextStageMockDb(reviewSettings, [
      { message: "[REVIEW:NEEDS_CHANGES] missing tests" },
    ]);
    __setLatestCheckResultsForTest("t-review-1", [
      { kind: "types", ok: true, durationMs: 1, output: "" },
    ]);

    const task = makeReviewTask("t-review-1");
    const result = determineNextStage(
      db as never,
      task,
      false,
      true,
      baseWorkflow,
    );
    assert.strictEqual(result, "in_progress");
  });

  it("forces in_progress when checks pass but reviewer left no verdict", () => {
    const db = createNextStageMockDb(reviewSettings, []);
    __setLatestCheckResultsForTest("t-review-1", [
      { kind: "types", ok: true, durationMs: 1, output: "" },
    ]);

    const task = makeReviewTask("t-review-1");
    const result = determineNextStage(
      db as never,
      task,
      false,
      true,
      baseWorkflow,
    );
    assert.strictEqual(result, "in_progress");
  });
});
