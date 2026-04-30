import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import { resolveStageAgentSelection } from "./stage-agent-resolver.js";
import { handleSpawnFailure } from "./spawn-failures.js";

/**
 * Trigger automatic test generation when a task transitions to "test_generation".
 *
 * Guards:
 *  - test_generation iteration count must be below max (prevents infinite loops)
 *  - an idle tester agent must be available
 */
export async function triggerAutoTestGen(
  db: DatabaseSync,
  ws: WsHub,
  task: Task,
): Promise<void> {
  const existingTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined;
  if (!existingTask) return;

  const currentTask = existingTask;

  // Loop prevention: count test_generation iterations
  const genCount = countTestGenIterations(db, currentTask.id);
  const maxGenCount = 2;
  if (genCount >= maxGenCount) {
    const now = Date.now();
    db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, currentTask.id);
    logSystem(db, currentTask.id, `Auto test generation stopped: iterations (${genCount}) reached max (${maxGenCount}). Returning to in_progress for manual action.`);
    ws.broadcast("task_update", { id: currentTask.id, status: "in_progress" });
    return;
  }

  // Find a suitable agent (prefer "tester" role)
  const decision = resolveTestGenAgent(db, currentTask.assigned_agent_id);
  if (decision.kind === "skip") {
    logSystem(db, currentTask.id, decision.reason);
    return;
  }
  const agent = decision.agent;
  if (!agent) {
    logSystem(db, currentTask.id, "Auto test generation skipped: no idle tester agent available");
    return;
  }

  logSystem(db, currentTask.id, `Auto test generation started: agent="${agent.name}" (${agent.id})`);
  ws.broadcast("cli_output", [{ task_id: currentTask.id, kind: "system", message: `[Auto Test Gen] Starting test generation with agent: ${agent.name}` }], { taskId: currentTask.id });

  const { spawnAgent } = await import("./process-manager.js");
  spawnAgent(db, ws, agent, currentTask, {}).catch((err) => {
    const handled = handleSpawnFailure(db, ws, currentTask.id, err, {
      source: "Auto test generation",
    });
    if (handled.handled) {
      return;
    }
    console.error(`[auto-test-gen] spawnAgent failed for task ${currentTask.id}:`, err);
  });
}

function countTestGenIterations(db: DatabaseSync, taskId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '%Auto test generation started%'"
  ).get(taskId) as { cnt: number };
  return row.cnt;
}

/**
 * Discriminated decision for the test-generation agent search. See
 * {@link QaAgentDecision} in `auto-qa.ts` for the same shape — the two
 * stages share semantics but live in their own files so the spawn
 * triggers stay independent.
 */
export type TestGenAgentDecision =
  | { kind: "agent"; agent: Agent | undefined }
  | { kind: "skip"; reason: string };

/**
 * Pick an idle agent for the test-generation stage. Honours the
 * `test_generation_agent_role` / `test_generation_agent_model` override
 * as a hard constraint: configured + match → use it, configured +
 * no match → skip.
 *
 * When the override is unconfigured, falls back to the legacy priority:
 *  1. an idle agent with role "tester" (excluding the implementer)
 *  2. any idle worker agent (excluding the implementer)
 *
 * Exported so the selector can be exercised by node:test without
 * spawning an external process.
 */
export function resolveTestGenAgent(
  db: DatabaseSync,
  implementerAgentId: string | null,
): TestGenAgentDecision {
  const overrideResult = resolveStageAgentSelection(
    db,
    "test_generation_agent_role",
    "test_generation_agent_model",
    { excludeIds: [implementerAgentId] },
  );

  if (overrideResult.status === "configured_match") {
    return { kind: "agent", agent: overrideResult.agent };
  }
  if (
    overrideResult.status === "configured_no_match"
    || overrideResult.status === "configured_no_match_in_pool"
  ) {
    return {
      kind: "skip",
      reason:
        "Auto test generation skipped: test_generation_agent_role/model is configured but no matching idle worker exists; will retry on the next test_generation trigger",
    };
  }

  const testerByRole = db
    .prepare(
      "SELECT * FROM agents WHERE role = 'tester' AND status = 'idle' AND id != ? LIMIT 1",
    )
    .get(implementerAgentId ?? "") as Agent | undefined;
  if (testerByRole) return { kind: "agent", agent: testerByRole };

  const anyIdle = db
    .prepare(
      "SELECT * FROM agents WHERE status = 'idle' AND agent_type = 'worker' AND id != ? LIMIT 1",
    )
    .get(implementerAgentId ?? "") as Agent | undefined;

  return { kind: "agent", agent: anyIdle };
}

function logSystem(db: DatabaseSync, taskId: string, message: string): void {
  // Auto-test-gen always runs for test_generation stage. Tag explicitly
  // to avoid trigger-fallback race with a concurrent status UPDATE.
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage) VALUES (?, 'system', ?, 'test_generation')"
  ).run(taskId, message);
}
