import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import type { CacheService } from "../cache/cache-service.js";
import { resolveStageAgentOverride } from "./stage-agent-resolver.js";

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
  cache?: CacheService,
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
    logSystem(db, currentTask.id, `Auto QA stopped: qa iterations (${qaCount}) reached max (${maxQaCount}). Moving to human_review — acceptance criteria not met after ${maxQaCount} attempts.`);
    ws.broadcast("task_update", { id: currentTask.id, status: "human_review" });
    return;
  }

  // Find a suitable QA agent
  const tester = findQaAgent(db, currentTask.assigned_agent_id);
  if (!tester) {
    logSystem(db, currentTask.id, "Auto QA skipped: no idle tester agent available");
    return;
  }

  logSystem(db, currentTask.id, `Auto QA started: agent="${tester.name}" (${tester.id})`);
  ws.broadcast("cli_output", [{ task_id: currentTask.id, kind: "system", message: `[Auto QA] Starting QA with agent: ${tester.name}` }], { taskId: currentTask.id });

  // Lazy import to break circular dependency (auto-qa <-> process-manager)
  const { spawnAgent } = await import("./process-manager.js");
  spawnAgent(db, ws, tester, currentTask, { cache });
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
 * Find an idle agent suitable for QA testing.
 *
 * Priority:
 *  1. Idle agent with role "tester" (excluding the implementer)
 *  2. Any idle worker agent (excluding the implementer)
 */
function findQaAgent(
  db: DatabaseSync,
  implementerAgentId: string | null,
): Agent | undefined {
  // Settings override: explicit qa_agent_id wins when the referenced
  // agent is idle and not the implementer.
  const override = resolveStageAgentOverride(db, "qa_agent_id", [implementerAgentId]);
  if (override) return override;

  // Try tester role first
  const testerByRole = db.prepare(
    "SELECT * FROM agents WHERE role = 'tester' AND status = 'idle' AND id != ? LIMIT 1"
  ).get(implementerAgentId ?? "") as Agent | undefined;

  if (testerByRole) return testerByRole;

  // Fallback: any idle worker (not the implementer)
  const anyIdle = db.prepare(
    "SELECT * FROM agents WHERE status = 'idle' AND agent_type = 'worker' AND id != ? LIMIT 1"
  ).get(implementerAgentId ?? "") as Agent | undefined;

  return anyIdle;
}

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function logSystem(db: DatabaseSync, taskId: string, message: string): void {
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
  ).run(taskId, message);
}
