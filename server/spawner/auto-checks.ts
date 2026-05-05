import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Task } from "../types/runtime.js";
import { loadProjectWorkflow, type ProjectWorkflow } from "../workflow/loader.js";
import { prepareTaskWorkspace } from "../workflow/workspace-manager.js";

/**
 * Kinds of automated checks that can run in parallel during the pr_review
 * phase. The order here matches the order of settings keys we look up.
 *
 * `types` / `lint` / `tests` are fast gates intended to finish alongside
 * the LLM reviewer. `e2e` is a slower gate (integration / Playwright /
 * pytest e2e) with a longer default timeout; projects that cannot afford
 * to block pr_review on e2e should leave that command unset.
 */
export const CHECK_KINDS = ["types", "lint", "tests", "e2e"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** Shell command to execute (passed to `bash -lc`). */
export interface CheckSpec {
  kind: CheckKind;
  command: string;
}

export interface CheckResult {
  kind: CheckKind;
  ok: boolean;
  durationMs: number;
  /** Combined stdout+stderr, truncated. */
  output: string;
}

/**
 * Default per-check timeout. tsc on larger projects can easily take 60s+,
 * so we give each check 2 minutes before killing it.
 */
export const CHECK_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * E2E suites typically take much longer than unit tests. This cap is
 * generous enough for a full Playwright run of a small-to-medium app
 * while still protecting the reviewer from a runaway suite blocking
 * pr_review indefinitely.
 */
export const CHECK_E2E_TIMEOUT_MS = 600_000;

/** Resolve the per-kind timeout budget. */
export function timeoutForKind(kind: CheckKind): number {
  return kind === "e2e" ? CHECK_E2E_TIMEOUT_MS : CHECK_DEFAULT_TIMEOUT_MS;
}

/** Max output bytes captured per check (to avoid ballooning task_logs). */
const MAX_OUTPUT_BYTES = 4_000;

/**
 * In-memory registry of active auto-check runs keyed by task id. The
 * review-finalize path awaits this promise via {@link waitForActiveChecks}
 * to make sure tsc/lint/test verdicts are present before the stage
 * pipeline decides whether to advance beyond pr_review.
 */
const activeCheckRuns = new Map<string, Promise<CheckResult[]>>();

/**
 * Latest completed check results per task, used by the stage pipeline
 * to gate pr_review advancement. Cleared at the start of every
 * {@link triggerAutoChecks} invocation so stale verdicts from a
 * previous pr_review cycle can never leak into the current one.
 */
const latestCheckResults = new Map<string, CheckResult[]>();

/**
 * Settings-driven feature toggle. Auto-checks are off by default so
 * existing deployments keep their previous behavior until an operator
 * explicitly opts in.
 */
export function isAutoChecksEnabled(db: DatabaseSync): boolean {
  return getSetting(db, "auto_checks_enabled") === "true";
}

/**
 * Resolve which checks should run for this project.
 *
 * Source of truth, in priority order:
 *   1. Per-project `WORKFLOW.md` fields
 *      (`check_types_cmd` / `check_lint_cmd` / `check_tests_cmd` /
 *      `check_e2e_cmd`)
 *   2. Global `settings` table keys (same names) — legacy path kept so
 *      operators can still configure at the server level without
 *      touching every project
 *
 * An empty / whitespace-only value skips that check. Missing also
 * skips. Workflow explicitly `null` falls through to settings.
 *
 * We intentionally do NOT auto-detect commands from package.json /
 * pyproject.toml here — keeping the source explicit avoids surprising
 * agents with commands they didn't opt into, and makes the feature
 * trivially testable.
 */
export function resolveCheckSpecs(
  db: DatabaseSync,
  workflow?: ProjectWorkflow | null,
): CheckSpec[] {
  const specs: CheckSpec[] = [];
  for (const kind of CHECK_KINDS) {
    const workflowCmd = workflow ? pickWorkflowCmd(workflow, kind) : null;
    const raw = workflowCmd ?? getSetting(db, `check_${kind}_cmd`);
    const command = raw?.trim();
    if (command) {
      specs.push({ kind, command });
    }
  }
  return specs;
}

function pickWorkflowCmd(
  workflow: ProjectWorkflow,
  kind: CheckKind,
): string | null {
  switch (kind) {
    case "types":
      return workflow.checkTypesCmd;
    case "lint":
      return workflow.checkLintCmd;
    case "tests":
      return workflow.checkTestsCmd;
    case "e2e":
      return workflow.checkE2eCmd;
  }
}

/**
 * Execute a single check as `bash -lc <command>` and capture its
 * exit status + combined output. Never throws — errors are reported
 * via `ok: false` so {@link runChecks} can always return a full
 * result set.
 */
export function runSingleCheck(
  spec: CheckSpec,
  cwd: string,
  timeoutMs: number = timeoutForKind(spec.kind),
): Promise<CheckResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("bash", ["-lc", spec.command], {
      cwd,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: string[] = [];
    let captured = 0;
    let truncatedBytes = 0;

    const append = (data: Buffer): void => {
      const text = data.toString();
      if (captured + text.length <= MAX_OUTPUT_BYTES) {
        chunks.push(text);
        captured += text.length;
      } else {
        const remaining = MAX_OUTPUT_BYTES - captured;
        if (remaining > 0) {
          chunks.push(text.slice(0, remaining));
          captured = MAX_OUTPUT_BYTES;
        }
        truncatedBytes += text.length - Math.max(remaining, 0);
      }
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (ok: boolean, extraLine?: string): void => {
      clearTimeout(timer);
      let output = chunks.join("").trim();
      if (truncatedBytes > 0) {
        output += `\n... (truncated ${truncatedBytes} bytes)`;
      }
      if (extraLine) {
        output = output ? `${extraLine}\n${output}` : extraLine;
      }
      resolve({
        kind: spec.kind,
        ok,
        durationMs: Date.now() - startedAt,
        output,
      });
    };

    child.on("error", (err) => {
      finish(false, `spawn error: ${err.message}`);
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish(false, `timed out after ${timeoutMs}ms`);
        return;
      }
      finish(code === 0);
    });
  });
}

/**
 * Run every spec in parallel and resolve with one result per spec.
 * Order of the returned array matches the order of the input specs.
 *
 * When `timeoutMs` is omitted each check uses its own kind-specific
 * timeout via {@link timeoutForKind} (e2e gets a longer budget).
 */
export function runChecks(
  specs: CheckSpec[],
  cwd: string,
  timeoutMs?: number,
): Promise<CheckResult[]> {
  return Promise.all(
    specs.map((spec) =>
      runSingleCheck(spec, cwd, timeoutMs ?? timeoutForKind(spec.kind)),
    ),
  );
}

/**
 * Fire auto-checks for a task that just entered pr_review.
 *
 * The function returns synchronously after registering the background
 * promise in {@link activeCheckRuns}. Callers do not need to await the
 * result — the review finalizer does that via {@link waitForActiveChecks}
 * before the stage pipeline decides the next status.
 *
 * If auto-checks is disabled or no commands are configured, this is a
 * no-op (the existing review-only path is preserved verbatim).
 */
export function triggerAutoChecks(
  db: DatabaseSync,
  ws: WsHub,
  task: Task,
): void {
  // Guard against double-trigger races. If another pr_review cycle is
  // still running auto-checks for this task (for example because the
  // same task id re-entered pr_review before the previous run
  // finished), do not start a second concurrent run — the results from
  // the two runs would non-deterministically overwrite each other in
  // `latestCheckResults`. Let the in-flight run finish first.
  if (activeCheckRuns.has(task.id)) {
    logSystem(
      db,
      task.id,
      "[CHECK:SKIP] another auto-checks run is already in flight for this task",
    );
    return;
  }

  // Always clear stale verdicts first. A previous pr_review cycle may
  // have left PASS/FAIL results in the map; if this invocation turns
  // out to be a no-op (feature disabled, no specs) we still want the
  // pipeline to see a clean "no results" state rather than last
  // cycle's verdict.
  latestCheckResults.delete(task.id);

  // No-op paths short-circuit synchronously so we don't register an
  // empty promise in `activeCheckRuns` — the presence of a promise is
  // used as a signal that checks are in flight.
  if (!isAutoChecksEnabled(db)) {
    logSystem(db, task.id, "[CHECK:SKIP] auto_checks_enabled is not 'true'");
    return;
  }

  // Load the project's WORKFLOW.md once so we can both resolve
  // per-project check commands AND reuse the workflow for the
  // workspace-manager call below. Crashes in file parsing fall back
  // to settings-only resolution.
  let workflow: ProjectWorkflow | null = null;
  try {
    workflow = loadProjectWorkflow(task.project_path ?? null);
  } catch (err) {
    logSystem(
      db,
      task.id,
      `[CHECK:WARN] WORKFLOW.md parse failed, using settings only: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const specs = resolveCheckSpecs(db, workflow);
  if (specs.length === 0) {
    logSystem(
      db,
      task.id,
      "[CHECK:SKIP] no commands configured (set check_types_cmd / check_lint_cmd / check_tests_cmd / check_e2e_cmd in WORKFLOW.md or settings)",
    );
    return;
  }

  // Determine cwd — prefer the worktree when the project uses
  // git-worktree workspace mode, otherwise fall back to project_path.
  const projectPath = task.project_path ?? process.cwd();
  let cwd = projectPath;
  try {
    const workspace = prepareTaskWorkspace(task, workflow, db);
    cwd = workspace.cwd;
  } catch (err) {
    // A workspace resolution failure means we cannot trust project_path.
    // Do not fall back to the raw path: that can run checks in an
    // unrelated parent repository.
    const message = err instanceof Error ? err.message : String(err);
    const failedResults: CheckResult[] = specs.map((spec) => ({
      kind: spec.kind,
      ok: false,
      durationMs: 0,
      output: `workspace resolution failed: ${message}`,
    }));
    latestCheckResults.set(task.id, failedResults);
    logSystem(
      db,
      task.id,
      `[CHECK:FAIL:workspace] workspace resolution failed: ${message}`,
    );
    ws.broadcast(
      "cli_output",
      [
        {
          task_id: task.id,
          kind: "system",
          message: "[Auto Checks] workspace resolution failed; checks were not run",
        },
      ],
      { taskId: task.id },
    );
    return;
  }

  // Emit a [CHECK:START:*] marker per spec so operators can see in the
  // task log what was dispatched, and so determineNextStage can tell
  // that checks are in-flight even if the run crashes before writing a
  // verdict.
  for (const spec of specs) {
    logSystem(db, task.id, `[CHECK:START:${spec.kind}] ${spec.command}`);
  }
  ws.broadcast(
    "cli_output",
    [
      {
        task_id: task.id,
        kind: "system",
        message: `[Auto Checks] running ${specs.length} check(s) in parallel: ${specs
          .map((s) => s.kind)
          .join(", ")}`,
      },
    ],
    { taskId: task.id },
  );

  // Kick off the actual run and register the promise so the review
  // finalizer can await it.
  const runPromise = runChecksAndRecord(db, ws, task, specs, cwd);
  activeCheckRuns.set(task.id, runPromise);
}

/**
 * Internal: run the checks, write verdict tags, broadcast completion,
 * and clean up the activeCheckRuns entry. Returns the raw results so
 * tests can observe them.
 */
async function runChecksAndRecord(
  db: DatabaseSync,
  ws: WsHub,
  task: Task,
  specs: CheckSpec[],
  cwd: string,
): Promise<CheckResult[]> {
  try {
    const results = await runChecks(specs, cwd);
    latestCheckResults.set(task.id, results);
    for (const result of results) {
      const tag = result.ok ? "PASS" : "FAIL";
      const snippet =
        result.output.length > 600
          ? `${result.output.slice(0, 600)}\n... (snippet)`
          : result.output;
      const body = snippet ? `\n${snippet}` : "";
      logSystem(
        db,
        task.id,
        `[CHECK:${tag}:${result.kind}] (${result.durationMs}ms)${body}`,
      );
    }
    const passed = results.filter((r) => r.ok).length;
    ws.broadcast(
      "cli_output",
      [
        {
          task_id: task.id,
          kind: "system",
          message: `[Auto Checks] finished: ${passed}/${results.length} passed`,
        },
      ],
      { taskId: task.id },
    );
    return results;
  } catch (err) {
    // Safety net: if something unexpected breaks (e.g. filesystem
    // error), record a FAIL marker for every spec so the stage
    // pipeline does not treat the missing verdict as "checks passed".
    const message = err instanceof Error ? err.message : String(err);
    const fallbackResults: CheckResult[] = specs.map((spec) => ({
      kind: spec.kind,
      ok: false,
      durationMs: 0,
      output: `crashed: ${message}`,
    }));
    latestCheckResults.set(task.id, fallbackResults);
    for (const spec of specs) {
      logSystem(
        db,
        task.id,
        `[CHECK:FAIL:${spec.kind}] auto-checks crashed: ${message}`,
      );
    }
    return fallbackResults;
  } finally {
    activeCheckRuns.delete(task.id);
  }
}

/**
 * Fetch the most recent completed check results for a task. Returns
 * `undefined` when auto-checks has never run (or was cleared) for this
 * task in the current process. The stage pipeline uses this to decide
 * whether to gate pr_review advancement on check verdicts.
 */
export function getLatestCheckResults(
  taskId: string,
): CheckResult[] | undefined {
  return latestCheckResults.get(taskId);
}

/** @internal Test hook to seed check results without running subprocesses. */
export function __setLatestCheckResultsForTest(
  taskId: string,
  results: CheckResult[],
): void {
  latestCheckResults.set(taskId, results);
}

/** @internal Test hook to clear check results. */
export function __clearLatestCheckResultsForTest(taskId: string): void {
  latestCheckResults.delete(taskId);
}

/**
 * Wait for any in-flight auto-check run for this task to settle.
 * Safe to call when no run is active (resolves immediately).
 */
export async function waitForActiveChecks(taskId: string): Promise<void> {
  const promise = activeCheckRuns.get(taskId);
  if (!promise) return;
  try {
    await promise;
  } catch {
    // Errors are already converted to FAIL tags inside
    // runChecksAndRecord; swallow here so callers never observe a
    // rejection from this gate.
  }
}

/** @internal Test hook to inspect the active-runs map. */
export function __hasActiveCheckRun(taskId: string): boolean {
  return activeCheckRuns.has(taskId);
}

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function logSystem(db: DatabaseSync, taskId: string, message: string): void {
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
  ).run(taskId, message);
}
