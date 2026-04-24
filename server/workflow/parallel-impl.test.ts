import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isParallelImplTestEnabled,
  hasParallelTestCompletion,
  recordParallelTestCompletion,
  PARALLEL_TEST_DONE_MARKER,
} from "./parallel-impl.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type StoredLog = { task_id: string; kind: string; message: string };

interface MockDbState {
  settings: Record<string, string>;
  logs: StoredLog[];
}

function createMockDb(initial: Partial<MockDbState> = {}): {
  db: any;
  state: MockDbState;
} {
  const state: MockDbState = {
    settings: initial.settings ?? {},
    logs: initial.logs ?? [],
  };

  const db = {
    prepare(sql: string) {
      const normalizedSql = sql.trim();
      return {
        get: (...args: unknown[]) => {
          if (/FROM\s+settings/i.test(normalizedSql)) {
            const key = args[0] as string;
            const value = state.settings[key];
            return value === undefined ? undefined : { value };
          }
          if (/FROM\s+task_logs/i.test(normalizedSql)) {
            const taskId = args[0] as string;
            // Find the most recent PARALLEL_TEST marker for the task
            const matching = state.logs.filter(
              (l) =>
                l.task_id === taskId &&
                l.kind === "system" &&
                l.message.includes(PARALLEL_TEST_DONE_MARKER),
            );
            if (matching.length === 0) return undefined;
            return { message: matching[matching.length - 1].message };
          }
          return undefined;
        },
        all: () => [],
        run: (...args: unknown[]) => {
          if (/INSERT\s+INTO\s+task_logs/i.test(normalizedSql)) {
            // Both production INSERTs hardcode kind='system' in the SQL, so
            // run() is called with (taskId, message) — only two args.
            const [taskId, message] = args as [string, string];
            state.logs.push({ task_id: taskId, kind: "system", message });
          }
        },
      };
    },
  };

  return { db, state };
}

// ---------------------------------------------------------------------------
// isParallelImplTestEnabled
// ---------------------------------------------------------------------------

describe("isParallelImplTestEnabled", () => {
  it("returns false when setting is unset (default behavior)", () => {
    const { db } = createMockDb();
    assert.strictEqual(isParallelImplTestEnabled(db), false);
  });

  it("returns false when setting is explicitly 'false'", () => {
    const { db } = createMockDb({
      settings: { enable_parallel_impl_test: "false" },
    });
    assert.strictEqual(isParallelImplTestEnabled(db), false);
  });

  it("returns true when setting is 'true'", () => {
    const { db } = createMockDb({
      settings: { enable_parallel_impl_test: "true" },
    });
    assert.strictEqual(isParallelImplTestEnabled(db), true);
  });

  it("returns false for any non-'true' value (e.g. 'yes', '1')", () => {
    const cases = ["yes", "1", "on", "enabled", ""];
    for (const value of cases) {
      const { db } = createMockDb({
        settings: { enable_parallel_impl_test: value },
      });
      assert.strictEqual(
        isParallelImplTestEnabled(db),
        false,
        `expected false for value="${value}" (only literal "true" enables parallel mode)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// recordParallelTestCompletion / hasParallelTestCompletion
// ---------------------------------------------------------------------------

describe("recordParallelTestCompletion", () => {
  it("inserts a system log with the DONE marker", () => {
    const { db, state } = createMockDb();

    recordParallelTestCompletion(db, "task-42", "pass");

    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].task_id, "task-42");
    assert.equal(state.logs[0].kind, "system");
    assert.ok(
      state.logs[0].message.includes(PARALLEL_TEST_DONE_MARKER),
      "expected log message to contain the DONE marker",
    );
    assert.ok(
      state.logs[0].message.includes("pass"),
      "expected verdict to be embedded in the marker",
    );
  });

  it("records a fail verdict when tester failed", () => {
    const { db, state } = createMockDb();

    recordParallelTestCompletion(db, "task-43", "fail");

    assert.ok(state.logs[0].message.includes("fail"));
  });
});

describe("hasParallelTestCompletion", () => {
  it("returns false when no marker exists for the task", () => {
    const { db } = createMockDb();
    assert.strictEqual(hasParallelTestCompletion(db, "task-1"), false);
  });

  it("returns true after recordParallelTestCompletion is called", () => {
    const { db } = createMockDb();
    recordParallelTestCompletion(db, "task-99", "pass");
    assert.strictEqual(hasParallelTestCompletion(db, "task-99"), true);
  });

  it("isolates markers per task id", () => {
    const { db } = createMockDb();
    recordParallelTestCompletion(db, "task-a", "pass");
    assert.strictEqual(hasParallelTestCompletion(db, "task-a"), true);
    assert.strictEqual(hasParallelTestCompletion(db, "task-b"), false);
  });

  // Regression: hasParallelTestCompletion is used by both triggerParallelTester
  // (idempotency guard — "don't spawn twice") and resolveActiveStages ("drop
  // the serial test_generation stage — the parallel tester already ran").
  // In BOTH callers we deliberately treat pass and fail as equivalent: a
  // failed tester run has still produced a result, and re-running the serial
  // stage would just be a no-op generator loop. Lock this in so a future
  // refactor that branches on verdict can't silently regress the guard.
  it("returns true even when the recorded verdict is fail (verdict-agnostic)", () => {
    const { db } = createMockDb();
    recordParallelTestCompletion(db, "task-verdict-fail", "fail");
    assert.strictEqual(
      hasParallelTestCompletion(db, "task-verdict-fail"),
      true,
      "a fail-verdict marker must still count as completion for idempotency",
    );
  });
});

// ---------------------------------------------------------------------------
// triggerParallelTester
// ---------------------------------------------------------------------------

describe("triggerParallelTester", () => {
  function createBaseTask(overrides: Partial<any> = {}): any {
    return {
      id: "task-1",
      title: "Implement feature X",
      description: null,
      assigned_agent_id: "agent-impl",
      project_path: "/tmp/project",
      status: "in_progress",
      priority: 0,
      task_size: "medium",
      task_number: "#1",
      review_count: 0,
      started_at: 1_000,
      updated_at: 1_000,
      created_at: 500,
      ...overrides,
    };
  }

  function createDbWithTester(opts: {
    settings?: Record<string, string>;
    testerAvailable?: boolean;
  }) {
    const state: {
      settings: Record<string, string>;
      logs: StoredLog[];
      spawnedAgentIds: string[];
    } = {
      settings: opts.settings ?? {},
      logs: [],
      spawnedAgentIds: [],
    };

    const tester =
      opts.testerAvailable === false
        ? undefined
        : {
            id: "agent-tester",
            name: "Tester",
            cli_provider: "claude",
            cli_model: null,
            cli_reasoning_level: null,
            avatar_emoji: "🧪",
            role: "tester",
            agent_type: "worker",
            personality: null,
            status: "idle",
            current_task_id: null,
            stats_tasks_done: 0,
            created_at: 0,
            updated_at: 0,
          };

    const db = {
      prepare(sql: string) {
        const normalizedSql = sql.trim();
        return {
          get: (...args: unknown[]) => {
            if (/FROM\s+settings/i.test(normalizedSql)) {
              const key = args[0] as string;
              const value = state.settings[key];
              return value === undefined ? undefined : { value };
            }
            if (/FROM\s+agents/i.test(normalizedSql)) {
              return tester;
            }
            if (/FROM\s+task_logs/i.test(normalizedSql)) {
              const taskId = args[0] as string;
              const matching = state.logs.filter(
                (l) =>
                  l.task_id === taskId &&
                  l.kind === "system" &&
                  l.message.includes(PARALLEL_TEST_DONE_MARKER),
              );
              if (matching.length === 0) return undefined;
              return { message: matching[matching.length - 1].message };
            }
            return undefined;
          },
          all: () => [],
          run: (...args: unknown[]) => {
            if (/INSERT\s+INTO\s+task_logs/i.test(normalizedSql)) {
              // Both production INSERTs hardcode kind='system' in the SQL, so
              // run() is called with (taskId, message) — only two args.
              const [taskId, message] = args as [string, string];
              state.logs.push({ task_id: taskId, kind: "system", message });
            }
          },
        };
      },
    };

    const ws = {
      broadcast: () => {},
    };

    return { db, ws, state };
  }

  it("does nothing when setting is disabled", async () => {
    const { db, ws, state } = createDbWithTester({ settings: {} });
    const task = createBaseTask();

    // Dynamic import to exercise the lazy module load path used by callers
    const { triggerParallelTester } = await import("./parallel-impl.js");
    const result = await triggerParallelTester(db as any, ws as any, task);

    assert.strictEqual(result.started, false);
    assert.strictEqual(result.reason, "disabled");
    assert.equal(state.logs.length, 0);
  });

  it("does nothing when task is not in in_progress state", async () => {
    const { db, ws } = createDbWithTester({
      settings: { enable_parallel_impl_test: "true" },
    });
    const task = createBaseTask({ status: "pr_review" });

    const { triggerParallelTester } = await import("./parallel-impl.js");
    const result = await triggerParallelTester(db as any, ws as any, task);

    assert.strictEqual(result.started, false);
    assert.strictEqual(result.reason, "wrong_status");
  });

  it("does nothing when no idle tester agent is available", async () => {
    const { db, ws, state } = createDbWithTester({
      settings: { enable_parallel_impl_test: "true" },
      testerAvailable: false,
    });
    const task = createBaseTask();

    const { triggerParallelTester } = await import("./parallel-impl.js");
    const result = await triggerParallelTester(db as any, ws as any, task);

    assert.strictEqual(result.started, false);
    assert.strictEqual(result.reason, "no_agent");
    // Should log the skip reason
    assert.ok(
      state.logs.some(
        (l) =>
          l.kind === "system" &&
          l.message.includes("no idle tester agent"),
      ),
      "expected a system log explaining why the parallel tester was skipped",
    );
  });

  it("records a system log when parallel tester is triggered", async () => {
    const { db, ws, state } = createDbWithTester({
      settings: { enable_parallel_impl_test: "true" },
    });
    const task = createBaseTask();

    const { triggerParallelTester } = await import("./parallel-impl.js");
    // Inject a spy spawner so the test doesn't actually start a subprocess
    const spawnCalls: Array<{
      agentId: string;
      taskId: string;
      parallelTester: boolean | undefined;
    }> = [];
    const result = await triggerParallelTester(db as any, ws as any, task, {
      spawnAgent: (_db: any, _ws: any, agent: any, t: any, opts: any) => {
        spawnCalls.push({
          agentId: agent.id,
          taskId: t.id,
          parallelTester: opts?.parallelTester,
        });
        return Promise.resolve({ pid: 1234 });
      },
    });

    assert.strictEqual(result.started, true);
    assert.strictEqual(result.reason, "spawned");
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].agentId, "agent-tester");
    assert.equal(spawnCalls[0].taskId, "task-1");
    // Must pass parallelTester: true so spawnAgent routes to the
    // test-gen prompt and skips task-level status updates.
    assert.strictEqual(spawnCalls[0].parallelTester, true);

    // Must have logged the start event
    assert.ok(
      state.logs.some(
        (l) =>
          l.kind === "system" &&
          l.message.includes("Parallel tester started"),
      ),
      "expected a system log announcing the parallel tester start",
    );
  });

  it("does not spawn a second tester if parallel test already completed for this task", async () => {
    const { db, ws, state } = createDbWithTester({
      settings: { enable_parallel_impl_test: "true" },
    });
    // Pre-populate a DONE marker to simulate a prior run
    state.logs.push({
      task_id: "task-1",
      kind: "system",
      message: `${PARALLEL_TEST_DONE_MARKER} pass`,
    });

    const task = createBaseTask();

    const { triggerParallelTester } = await import("./parallel-impl.js");
    const spawnCalls: Array<string> = [];
    const result = await triggerParallelTester(db as any, ws as any, task, {
      spawnAgent: (_db: any, _ws: any, agent: any) => {
        spawnCalls.push(agent.id);
        return Promise.resolve({ pid: 1 });
      },
    });

    assert.strictEqual(result.started, false);
    assert.strictEqual(result.reason, "already_done");
    assert.equal(spawnCalls.length, 0);
  });
});
