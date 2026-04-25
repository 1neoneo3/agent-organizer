import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";

/**
 * AO Phase 3: parallel implementer + tester orchestration.
 *
 * When `settings.enable_parallel_impl_test === "true"`, a tester agent is
 * spawned *in parallel* with the implementer during the `in_progress` stage
 * instead of waiting for the implementer to finish and then running a
 * separate `test_generation` stage. Since both agents share the same task
 * worktree, their prompts must enforce directory-level scope boundaries
 * (see `prompt-builder.ts`) so they don't collide.
 *
 * This module is intentionally minimal and free of side effects outside the
 * DB / WsHub / spawner it is handed. It can be dynamically imported from
 * `process-manager.ts` without pulling in any new top-level state.
 */

/** Marker logged to `task_logs` when the parallel tester completes. */
export const PARALLEL_TEST_DONE_MARKER = "[PARALLEL_TEST:DONE]";

/** Key for the opt-in settings flag. */
export const PARALLEL_IMPL_TEST_SETTING_KEY = "enable_parallel_impl_test";

/**
 * Return true when the operator has opted in to parallel implementer/tester
 * execution. Defaults to `false` so existing installations keep the serial
 * `in_progress → test_generation → pr_review` pipeline untouched.
 */
export function isParallelImplTestEnabled(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(PARALLEL_IMPL_TEST_SETTING_KEY) as { value: string } | undefined;
  return row?.value === "true";
}

/**
 * Return true when a parallel tester has already completed for the given
 * task (a DONE marker exists in `task_logs`). Used to make
 * `triggerParallelTester` idempotent and to let `stage-pipeline.ts` skip the
 * now-unnecessary `test_generation` stage.
 */
export function hasParallelTestCompletion(
  db: DatabaseSync,
  taskId: string,
): boolean {
  const row = db
    .prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE ? ORDER BY id DESC LIMIT 1",
    )
    .get(taskId, `${PARALLEL_TEST_DONE_MARKER}%`) as
    | { message: string }
    | undefined;
  return row !== undefined;
}

/**
 * Record that the parallel tester has completed for a task. The verdict is
 * embedded in the log message so that downstream stages (or humans reading
 * logs) can distinguish "tests generated and passing" from "tests generated
 * but failed" without re-running anything.
 */
export function recordParallelTestCompletion(
  db: DatabaseSync,
  taskId: string,
  verdict: "pass" | "fail",
): void {
  // Parallel tester runs the test_generation prompt while the implementer
  // task stays in in_progress. Tag the DONE marker as test_generation so
  // log filters and the plan-extraction query can distinguish it from
  // implementer output without depending on the trigger fallback.
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage) VALUES (?, 'system', ?, 'test_generation')",
  ).run(taskId, `${PARALLEL_TEST_DONE_MARKER} ${verdict}`);
}

export type TriggerReason =
  | "disabled"
  | "wrong_status"
  | "no_agent"
  | "already_done"
  | "spawned";

export interface TriggerParallelTesterResult {
  started: boolean;
  reason: TriggerReason;
}

/**
 * Spawn helper signature used by `triggerParallelTester`.
 *
 * This mirrors the shape of `spawnAgent` in `process-manager.ts` but is
 * accepted as an injectable dependency so tests don't need to start a real
 * subprocess. At runtime, `triggerParallelTester` falls back to the real
 * `spawnAgent` via dynamic import (same pattern as `auto-reviewer.ts`), so
 * callers in `process-manager.ts` do not need to pass anything.
 */
export type SpawnAgentFn = (
  db: DatabaseSync,
  ws: WsHub,
  agent: Agent,
  task: Task,
  options?: { parallelTester?: boolean },
) => Promise<{ pid: number }>;

export interface TriggerParallelTesterOptions {
  /** Override the spawner (for tests). Defaults to the real `spawnAgent`. */
  spawnAgent?: SpawnAgentFn;
}

/**
 * Fire-and-forget: if parallel impl/test mode is enabled and the task is
 * currently in `in_progress`, spawn a tester agent now so that test
 * generation can run concurrently with the implementer instead of serially
 * after it. The implementer spawn is handled elsewhere — this function
 * contributes the *tester* side of the parallel pair.
 *
 * Idempotent: safe to call multiple times for the same task. A second call
 * short-circuits if a `PARALLEL_TEST:DONE` marker already exists.
 */
export async function triggerParallelTester(
  db: DatabaseSync,
  ws: WsHub,
  task: Task,
  options: TriggerParallelTesterOptions = {},
): Promise<TriggerParallelTesterResult> {
  if (!isParallelImplTestEnabled(db)) {
    return { started: false, reason: "disabled" };
  }

  if (task.status !== "in_progress") {
    return { started: false, reason: "wrong_status" };
  }

  if (hasParallelTestCompletion(db, task.id)) {
    return { started: false, reason: "already_done" };
  }

  const tester = findTesterAgent(db, task.assigned_agent_id);
  if (!tester) {
    logSystem(
      db,
      task.id,
      "Parallel tester skipped: no idle tester agent available",
    );
    return { started: false, reason: "no_agent" };
  }

  logSystem(
    db,
    task.id,
    `Parallel tester started: agent="${tester.name}" (${tester.id})`,
  );
  ws.broadcast(
    "cli_output",
    [
      {
        task_id: task.id,
        kind: "system",
        message: `[Parallel Tester] Starting concurrently with implementer via agent: ${tester.name}`,
      },
    ],
    { taskId: task.id },
  );

  const spawnAgent =
    options.spawnAgent ??
    (
      await import("../spawner/process-manager.js")
    ).spawnAgent;
  const { handleSpawnFailure } = await import("../spawner/spawn-failures.js");

  spawnAgent(db, ws, tester, task, {
    parallelTester: true,
  }).catch((err) => {
    const handled = handleSpawnFailure(db, ws, task.id, err, {
      source: "Parallel tester",
    });
    if (handled.handled) {
      return;
    }
    console.error(`[parallel-impl] tester spawn failed for task ${task.id}:`, err);
  });

  return { started: true, reason: "spawned" };
}

/**
 * Find an idle tester agent, preferring ones with role="tester", falling
 * back to any idle worker that is not the current implementer. Mirrors the
 * selection strategy used by `auto-test-gen.ts` so parallel mode and serial
 * mode pick the same agents.
 */
function findTesterAgent(
  db: DatabaseSync,
  implementerAgentId: string | null,
): Agent | undefined {
  const testerByRole = db
    .prepare(
      "SELECT * FROM agents WHERE role = 'tester' AND status = 'idle' AND id != ? LIMIT 1",
    )
    .get(implementerAgentId ?? "") as Agent | undefined;

  if (testerByRole) return testerByRole;

  const anyIdle = db
    .prepare(
      "SELECT * FROM agents WHERE status = 'idle' AND agent_type = 'worker' AND id != ? LIMIT 1",
    )
    .get(implementerAgentId ?? "") as Agent | undefined;

  return anyIdle;
}

function logSystem(db: DatabaseSync, taskId: string, message: string): void {
  // Parallel-impl trigger runs during in_progress (the implementer's stage).
  // Tag explicitly so orchestration messages ("parallel tester started", etc.)
  // land on the implementer's timeline without trigger-fallback race.
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage) VALUES (?, 'system', ?, 'in_progress')",
  ).run(taskId, message);
}
