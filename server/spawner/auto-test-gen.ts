import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import type { CacheService } from "../cache/cache-service.js";
import { resolveStageAgentOverride } from "./stage-agent-resolver.js";

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
  cache?: CacheService,
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
  const agent = findTestGenAgent(db, currentTask.assigned_agent_id);
  if (!agent) {
    logSystem(db, currentTask.id, "Auto test generation skipped: no idle tester agent available");
    return;
  }

  logSystem(db, currentTask.id, `Auto test generation started: agent="${agent.name}" (${agent.id})`);
  ws.broadcast("cli_output", [{ task_id: currentTask.id, kind: "system", message: `[Auto Test Gen] Starting test generation with agent: ${agent.name}` }], { taskId: currentTask.id });

  const { spawnAgent } = await import("./process-manager.js");
  spawnAgent(db, ws, agent, currentTask, { cache });
}

function countTestGenIterations(db: DatabaseSync, taskId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '%Auto test generation started%'"
  ).get(taskId) as { cnt: number };
  return row.cnt;
}

function findTestGenAgent(
  db: DatabaseSync,
  implementerAgentId: string | null,
): Agent | undefined {
  const override = resolveStageAgentOverride(db, "test_generation_agent_id", [implementerAgentId]);
  if (override) return override;

  const testerByRole = db.prepare(
    "SELECT * FROM agents WHERE role = 'tester' AND status = 'idle' AND id != ? LIMIT 1"
  ).get(implementerAgentId ?? "") as Agent | undefined;

  if (testerByRole) return testerByRole;

  const anyIdle = db.prepare(
    "SELECT * FROM agents WHERE status = 'idle' AND agent_type = 'worker' AND id != ? LIMIT 1"
  ).get(implementerAgentId ?? "") as Agent | undefined;

  return anyIdle;
}

function logSystem(db: DatabaseSync, taskId: string, message: string): void {
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
  ).run(taskId, message);
}
