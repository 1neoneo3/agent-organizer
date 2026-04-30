import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import { resolveStageAgentSelection } from "./stage-agent-resolver.js";
import { handleSpawnFailure } from "./spawn-failures.js";

/**
 * Trigger automatic QA testing when a task transitions to "qa_testing".
 *
 * Guards:
 *  - auto_qa setting must be enabled
 *  - QA iteration count (tracked via system logs) must be below max
 *  - an idle tester agent must be available
 */
export async function triggerAutoQa(
  db: DatabaseSync,
  ws: WsHub,
  task: Task,
): Promise<void> {
  const existingTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined;
  if (!existingTask) {
    return;
  }

  const currentTask = existingTask;

  // Check auto_qa setting
  const autoQa = getSetting(db, "auto_qa") ?? "true";
  if (autoQa !== "true") {
    logSystem(db, currentTask.id, "Auto QA skipped: disabled in settings");
    return;
  }

  // Loop prevention: count QA iterations via system logs
  const qaCount = countQaIterations(db, currentTask.id);
  const maxQaCount = Number(getSetting(db, "qa_count") ?? "2");
  if (qaCount >= maxQaCount) {
    const now = Date.now();
    db.prepare("UPDATE tasks SET status = 'human_review', updated_at = ? WHERE id = ?").run(now, currentTask.id);
    logSystem(
      db,
      currentTask.id,
      `Auto QA stopped: qa iterations (${qaCount}) reached max (${maxQaCount}). Moving to human_review — acceptance criteria not met after ${maxQaCount} attempts.`,
      "human_review",
    );
    ws.broadcast("task_update", { id: currentTask.id, status: "human_review" });
    // Hand off to auto_human_review when enabled. Safe to call
    // unconditionally — the trigger gates on the setting and the cap.
    const { triggerAutoHumanReview } = await import("./auto-human-reviewer.js");
    const handoffTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(currentTask.id) as Task | undefined;
    if (handoffTask) {
      setTimeout(() => triggerAutoHumanReview(db, ws, handoffTask), 500);
    }
    return;
  }

  // Find a suitable QA agent
  const decision = resolveQaAgent(db, currentTask.assigned_agent_id);
  if (decision.kind === "skip") {
    logSystem(db, currentTask.id, decision.reason);
    ws.broadcast(
      "cli_output",
      [{ task_id: currentTask.id, kind: "system", message: `[Auto QA] ${decision.reason}` }],
      { taskId: currentTask.id },
    );
    return;
  }
  const tester = decision.agent;
  if (!tester) {
    logSystem(db, currentTask.id, "Auto QA skipped: no idle tester agent available");
    return;
  }

  logSystem(db, currentTask.id, `Auto QA started: agent="${tester.name}" (${tester.id})`);
  ws.broadcast("cli_output", [{ task_id: currentTask.id, kind: "system", message: `[Auto QA] Starting QA with agent: ${tester.name}` }], { taskId: currentTask.id });

  // Lazy import to break circular dependency (auto-qa <-> process-manager)
  const { spawnAgent } = await import("./process-manager.js");
  spawnAgent(db, ws, tester, currentTask, {}).catch((err) => {
    const handled = handleSpawnFailure(db, ws, currentTask.id, err, {
      source: "Auto QA",
    });
    if (handled.handled) {
      return;
    }
    console.error(`[auto-qa] spawnAgent failed for task ${currentTask.id}:`, err);
  });
}

/**
 * Count QA iterations by counting "Auto QA started" system logs for this task.
 */
function countQaIterations(db: DatabaseSync, taskId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '%Auto QA started%'"
  ).get(taskId) as { cnt: number };
  return row.cnt;
}

/**
 * Discriminated decision for the QA agent search.
 *
 *  - `agent`: a worker has been chosen — `agent` may still be
 *    `undefined` when neither the override nor the role-based
 *    fallback turned up an idle worker (e.g. nobody registered).
 *  - `skip`: `qa_agent_role` / `qa_agent_model` is configured but no
 *    matching idle worker is reachable. The caller must NOT fall back
 *    to a generic tester / worker; instead it should log + return so
 *    the next qa_testing trigger picks up the configured worker.
 */
export type QaAgentDecision =
  | { kind: "agent"; agent: Agent | undefined }
  | { kind: "skip"; reason: string };

/**
 * Pick an idle agent for the QA stage. Honours the
 * `qa_agent_role` / `qa_agent_model` override as a hard constraint:
 * configured + match → use it, configured + no match → skip.
 *
 * When the override is unconfigured, falls back to the legacy priority:
 *  1. an idle agent with role "tester" (excluding the implementer)
 *  2. any idle worker agent (excluding the implementer)
 *
 * Exported so the selector can be exercised by node:test without
 * spawning an external process.
 */
export function resolveQaAgent(
  db: DatabaseSync,
  implementerAgentId: string | null,
): QaAgentDecision {
  const overrideResult = resolveStageAgentSelection(
    db,
    "qa_agent_role",
    "qa_agent_model",
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
        "Auto QA skipped: qa_agent_role/model is configured but no matching idle worker exists; will retry on the next qa_testing trigger",
    };
  }

  // Unconfigured: legacy fallback.
  const testerByRole = db
    .prepare(
      "SELECT * FROM agents WHERE role = 'tester' AND status = 'idle' AND current_task_id IS NULL AND id != ? LIMIT 1",
    )
    .get(implementerAgentId ?? "") as Agent | undefined;
  if (testerByRole) return { kind: "agent", agent: testerByRole };

  const anyIdle = db
    .prepare(
      "SELECT * FROM agents WHERE status = 'idle' AND current_task_id IS NULL AND agent_type = 'worker' AND id != ? LIMIT 1",
    )
    .get(implementerAgentId ?? "") as Agent | undefined;

  return { kind: "agent", agent: anyIdle };
}

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function logSystem(
  db: DatabaseSync,
  taskId: string,
  message: string,
  stage: "qa_testing" | "human_review" = "qa_testing",
): void {
  // Auto-QA always runs for qa_testing stage. Tag explicitly to avoid
  // trigger-fallback race with a concurrent status UPDATE. Escalation
  // messages are tagged as human_review because they are emitted after
  // the task has already crossed that transition.
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage) VALUES (?, 'system', ?, ?)"
  ).run(taskId, message, stage);
}
