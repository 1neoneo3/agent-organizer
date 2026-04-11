import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __hasActiveCheckRun,
  isAutoChecksEnabled,
  resolveCheckSpecs,
  runChecks,
  runSingleCheck,
  triggerAutoChecks,
  waitForActiveChecks,
} from "./auto-checks.js";

/**
 * Minimal in-memory stand-in for the settings / task_logs tables.
 * The real auto-checks module only touches two SQL statements:
 *
 *   - `SELECT value FROM settings WHERE key = ?`
 *   - `INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)`
 *
 * so the fake DB just pattern-matches those and records the side effects.
 */
function createFakeDb(settings: Record<string, string> = {}) {
  const logs: Array<{ taskId: string; kind: string; message: string }> = [];
  const db = {
    logs,
    prepare(sql: string) {
      if (sql.startsWith("SELECT value FROM settings")) {
        return {
          get: (key: unknown) => {
            if (typeof key !== "string") return undefined;
            const value = settings[key];
            return value === undefined ? undefined : { value };
          },
        };
      }
      if (sql.startsWith("INSERT INTO task_logs")) {
        // The real statement inlines the `'system'` kind literal, so
        // `.run` is called with just (taskId, message). We reflect that
        // shape here instead of mirroring the table columns.
        return {
          run: (taskId: unknown, message: unknown) => {
            logs.push({
              taskId: String(taskId),
              kind: "system",
              message: String(message),
            });
          },
        };
      }
      throw new Error(`unexpected SQL in test: ${sql}`);
    },
  };
  return db;
}

function createWsStub() {
  const events: Array<{ type: string; payload: unknown }> = [];
  return {
    events,
    broadcast(type: string, payload: unknown, _opts?: unknown) {
      events.push({ type, payload });
    },
  };
}

/**
 * Create a temporary working directory with just enough scaffolding to
 * act as a cwd for `bash -lc` commands. Tests that only run harmless
 * shell builtins (echo / false / etc.) are safe against any real repo.
 */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ao-checks-"));
}

/**
 * Build a Task-shaped object with project_path pointing at a tmp dir,
 * so `prepareTaskWorkspace` resolves without touching the real repo.
 */
function makeFakeTask(taskId: string) {
  const dir = makeTmpDir();
  // Empty file so git detection won't crash even if we happened to
  // load a workflow here (we set workspaceMode to shared via the
  // default WORKFLOW loader, so no worktree is created).
  writeFileSync(join(dir, ".keep"), "");
  return {
    id: taskId,
    project_path: dir,
    assigned_agent_id: null,
    status: "pr_review" as const,
    review_count: 1,
    started_at: Date.now() - 1000,
  };
}

function makeWorkflowStub(
  overrides: Partial<{
    checkTypesCmd: string | null;
    checkLintCmd: string | null;
    checkTestsCmd: string | null;
    checkE2eCmd: string | null;
  }>,
) {
  return {
    checkTypesCmd: null,
    checkLintCmd: null,
    checkTestsCmd: null,
    checkE2eCmd: null,
    ...overrides,
  } as never;
}

describe("resolveCheckSpecs", () => {
  it("returns nothing when no check settings are configured", () => {
    const db = createFakeDb({});
    assert.deepEqual(resolveCheckSpecs(db as never), []);
  });

  it("includes only the check kinds that have non-empty commands", () => {
    const db = createFakeDb({
      check_types_cmd: "tsc --noEmit",
      check_lint_cmd: "  ", // whitespace = skip
      check_tests_cmd: "pytest -q",
    });
    const specs = resolveCheckSpecs(db as never);
    assert.deepEqual(
      specs.map((s) => s.kind),
      ["types", "tests"],
    );
    assert.equal(specs[0]?.command, "tsc --noEmit");
    assert.equal(specs[1]?.command, "pytest -q");
  });

  it("trims leading/trailing whitespace from commands", () => {
    const db = createFakeDb({
      check_lint_cmd: "   eslint .   ",
    });
    const specs = resolveCheckSpecs(db as never);
    assert.deepEqual(specs, [{ kind: "lint", command: "eslint ." }]);
  });

  it("picks workflow.checkTypesCmd over the settings key", () => {
    const db = createFakeDb({
      check_types_cmd: "tsc-from-settings",
    });
    const workflow = makeWorkflowStub({
      checkTypesCmd: "pnpm exec tsc --noEmit",
    });
    const specs = resolveCheckSpecs(db as never, workflow);
    assert.deepEqual(specs, [
      { kind: "types", command: "pnpm exec tsc --noEmit" },
    ]);
  });

  it("falls back to the settings key when workflow has that field null", () => {
    const db = createFakeDb({
      check_lint_cmd: "ruff check .",
    });
    const workflow = makeWorkflowStub({
      checkTypesCmd: "tsc --noEmit",
      // checkLintCmd stays null → settings wins
    });
    const specs = resolveCheckSpecs(db as never, workflow);
    assert.deepEqual(
      specs.map((s) => s.command),
      ["tsc --noEmit", "ruff check ."],
    );
  });

  it("includes the e2e kind when check_e2e_cmd is set in workflow", () => {
    const db = createFakeDb({});
    const workflow = makeWorkflowStub({
      checkE2eCmd: "playwright test",
    });
    const specs = resolveCheckSpecs(db as never, workflow);
    assert.deepEqual(specs, [{ kind: "e2e", command: "playwright test" }]);
  });

  it("includes the e2e kind when check_e2e_cmd is set in settings", () => {
    const db = createFakeDb({ check_e2e_cmd: "pytest tests/e2e" });
    const specs = resolveCheckSpecs(db as never);
    assert.deepEqual(specs, [{ kind: "e2e", command: "pytest tests/e2e" }]);
  });
});

describe("isAutoChecksEnabled", () => {
  it("defaults to disabled when setting is absent", () => {
    const db = createFakeDb({});
    assert.equal(isAutoChecksEnabled(db as never), false);
  });

  it("returns true only when set to exactly 'true'", () => {
    assert.equal(
      isAutoChecksEnabled(createFakeDb({ auto_checks_enabled: "true" }) as never),
      true,
    );
    assert.equal(
      isAutoChecksEnabled(createFakeDb({ auto_checks_enabled: "TRUE" }) as never),
      false,
    );
    assert.equal(
      isAutoChecksEnabled(createFakeDb({ auto_checks_enabled: "1" }) as never),
      false,
    );
    assert.equal(
      isAutoChecksEnabled(createFakeDb({ auto_checks_enabled: "" }) as never),
      false,
    );
  });
});

describe("runSingleCheck", () => {
  it("reports ok=true for exit code 0", async () => {
    const dir = makeTmpDir();
    const result = await runSingleCheck(
      { kind: "types", command: "echo hello" },
      dir,
      5_000,
    );
    assert.equal(result.ok, true);
    assert.equal(result.kind, "types");
    assert.ok(result.output.includes("hello"));
    assert.ok(result.durationMs >= 0);
  });

  it("reports ok=false for non-zero exit code", async () => {
    const dir = makeTmpDir();
    const result = await runSingleCheck(
      { kind: "lint", command: "false" },
      dir,
      5_000,
    );
    assert.equal(result.ok, false);
    assert.equal(result.kind, "lint");
  });

  it("captures stderr output alongside stdout", async () => {
    const dir = makeTmpDir();
    const result = await runSingleCheck(
      {
        kind: "tests",
        command: "echo OUT && echo ERR 1>&2 && exit 2",
      },
      dir,
      5_000,
    );
    assert.equal(result.ok, false);
    assert.ok(result.output.includes("OUT"));
    assert.ok(result.output.includes("ERR"));
  });

  it("kills the child and reports failure on timeout", async () => {
    const dir = makeTmpDir();
    const result = await runSingleCheck(
      { kind: "types", command: "sleep 5" },
      dir,
      200,
    );
    assert.equal(result.ok, false);
    assert.ok(result.output.includes("timed out"));
  });
});

describe("runChecks (parallel)", () => {
  it("executes all specs and preserves input order in the result array", async () => {
    const dir = makeTmpDir();
    const results = await runChecks(
      [
        { kind: "types", command: "echo t" },
        { kind: "lint", command: "echo l" },
        { kind: "tests", command: "echo ts" },
      ],
      dir,
      5_000,
    );
    assert.deepEqual(
      results.map((r) => r.kind),
      ["types", "lint", "tests"],
    );
    assert.ok(results.every((r) => r.ok));
  });

  it("actually runs in parallel — total wall time is not the sum", async () => {
    const dir = makeTmpDir();
    const started = Date.now();
    const results = await runChecks(
      [
        { kind: "types", command: "sleep 0.4" },
        { kind: "lint", command: "sleep 0.4" },
        { kind: "tests", command: "sleep 0.4" },
      ],
      dir,
      5_000,
    );
    const elapsed = Date.now() - started;
    assert.ok(results.every((r) => r.ok));
    // Three sequential sleeps would take ~1.2s. Parallel should finish
    // well under that; give a generous upper bound for CI noise.
    assert.ok(elapsed < 1_000, `expected parallel execution, got ${elapsed}ms`);
  });
});

describe("triggerAutoChecks", () => {
  it("is a no-op and logs SKIP when disabled", () => {
    const db = createFakeDb({ auto_checks_enabled: "false" });
    const ws = createWsStub();
    const task = makeFakeTask("task-disabled");

    triggerAutoChecks(db as never, ws as never, task as never);

    assert.equal(__hasActiveCheckRun(task.id), false);
    assert.ok(
      db.logs.some((l) => l.message.includes("[CHECK:SKIP]")),
      "expected SKIP log when disabled",
    );
    assert.equal(ws.events.length, 0);
  });

  it("is a no-op and logs SKIP when enabled but no commands set", () => {
    const db = createFakeDb({ auto_checks_enabled: "true" });
    const ws = createWsStub();
    const task = makeFakeTask("task-empty");

    triggerAutoChecks(db as never, ws as never, task as never);

    assert.equal(__hasActiveCheckRun(task.id), false);
    assert.ok(
      db.logs.some((l) => l.message.includes("no commands configured")),
    );
  });

  it("registers an active run and writes PASS tags when all checks succeed", async () => {
    const db = createFakeDb({
      auto_checks_enabled: "true",
      check_types_cmd: "echo types-ok",
      check_lint_cmd: "echo lint-ok",
      check_tests_cmd: "echo tests-ok",
    });
    const ws = createWsStub();
    const task = makeFakeTask("task-happy");

    triggerAutoChecks(db as never, ws as never, task as never);

    // Synchronously after trigger: START markers should be logged and
    // a run should be tracked as active.
    const startLogs = db.logs.filter((l) =>
      l.message.startsWith("[CHECK:START:"),
    );
    assert.equal(startLogs.length, 3, "expected 3 [CHECK:START:*] markers");
    assert.equal(__hasActiveCheckRun(task.id), true);

    await waitForActiveChecks(task.id);

    // After the run settles: PASS tags for all three kinds, and the
    // registry entry must be cleared.
    const passLogs = db.logs.filter((l) =>
      l.message.startsWith("[CHECK:PASS:"),
    );
    assert.equal(passLogs.length, 3, "expected 3 PASS tags");
    const kinds = passLogs
      .map((l) => l.message.match(/\[CHECK:PASS:(\w+)\]/)?.[1])
      .filter(Boolean)
      .sort();
    assert.deepEqual(kinds, ["lint", "tests", "types"]);
    assert.equal(__hasActiveCheckRun(task.id), false);
  });

  it("writes FAIL tag for a failing check and PASS tag for siblings", async () => {
    const db = createFakeDb({
      auto_checks_enabled: "true",
      check_types_cmd: "echo ok",
      check_lint_cmd: "false",
    });
    const ws = createWsStub();
    const task = makeFakeTask("task-partial");

    triggerAutoChecks(db as never, ws as never, task as never);
    await waitForActiveChecks(task.id);

    const passLog = db.logs.find((l) =>
      l.message.startsWith("[CHECK:PASS:types]"),
    );
    const failLog = db.logs.find((l) =>
      l.message.startsWith("[CHECK:FAIL:lint]"),
    );
    assert.ok(passLog, "types check should have PASS tag");
    assert.ok(failLog, "lint check should have FAIL tag");
  });

  it("waitForActiveChecks resolves immediately when no run is active", async () => {
    const before = Date.now();
    await waitForActiveChecks("never-triggered");
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 50, `expected fast return, took ${elapsed}ms`);
  });

  it("ignores a concurrent second trigger while the first is still running", async () => {
    const db = createFakeDb({
      auto_checks_enabled: "true",
      // Use a sleep so the first run is still in flight when the
      // second trigger fires. 150ms is short enough to keep the test
      // quick but long enough to win the race reliably.
      check_types_cmd: "sleep 0.15 && echo ok",
    });
    const ws = createWsStub();
    const task = makeFakeTask("task-double");

    triggerAutoChecks(db as never, ws as never, task as never);
    triggerAutoChecks(db as never, ws as never, task as never);

    await waitForActiveChecks(task.id);

    const skipLogs = db.logs.filter((l) =>
      l.message.startsWith("[CHECK:SKIP]"),
    );
    assert.ok(
      skipLogs.some((l) => l.message.includes("already in flight")),
      "expected SKIP log for the second concurrent trigger",
    );
    // Only one PASS tag (single run, single check kind)
    const passLogs = db.logs.filter((l) =>
      l.message.startsWith("[CHECK:PASS:types]"),
    );
    assert.equal(passLogs.length, 1);
  });
});
