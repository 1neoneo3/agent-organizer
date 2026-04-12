import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import type { CacheService } from "../cache/cache-service.js";

/**
 * Trigger automatic ci-check verification when a task transitions to "ci_check".
 *
 * Guards:
 *  - ci_check iteration count must be below max (prevents infinite loops)
 *  - an idle devops agent must be available
 */
export async function triggerAutoCiCheck(
  db: DatabaseSync,
  ws: WsHub,
  task: Task,
  cache?: CacheService,
): Promise<void> {
  const existingTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined;
  if (!existingTask) return;

  const currentTask = existingTask;

  // Loop prevention
  const deployCount = countCiCheckIterations(db, currentTask.id);
  const maxDeployCount = 2;
  if (deployCount >= maxDeployCount) {
    const now = Date.now();
    db.prepare("UPDATE tasks SET status = 'pr_review', updated_at = ? WHERE id = ?").run(now, currentTask.id);
    logSystem(db, currentTask.id, `Auto ci-check stopped: iterations (${deployCount}) reached max (${maxDeployCount}). Returning to pr_review for manual action.`);
    ws.broadcast("task_update", { id: currentTask.id, status: "pr_review" });
    return;
  }

  // Find a suitable agent (prefer "devops" role)
  const agent = findCiCheckAgent(db, currentTask.assigned_agent_id);
  if (!agent) {
    logSystem(db, currentTask.id, "Auto ci-check skipped: no idle devops agent available");
    return;
  }

  logSystem(db, currentTask.id, `Auto ci-check started: agent="${agent.name}" (${agent.id})`);
  ws.broadcast("cli_output", [{ task_id: currentTask.id, kind: "system", message: `[Auto Pre-Deploy] Starting ci-check verification with agent: ${agent.name}` }], { taskId: currentTask.id });

  const { spawnAgent } = await import("./process-manager.js");
  spawnAgent(db, ws, agent, currentTask, { cache });
}

function countCiCheckIterations(db: DatabaseSync, taskId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '%Auto ci-check started%'"
  ).get(taskId) as { cnt: number };
  return row.cnt;
}

function findCiCheckAgent(
  db: DatabaseSync,
  implementerAgentId: string | null,
): Agent | undefined {
  const devopsByRole = db.prepare(
    "SELECT * FROM agents WHERE role = 'devops' AND status = 'idle' AND id != ? LIMIT 1"
  ).get(implementerAgentId ?? "") as Agent | undefined;

  if (devopsByRole) return devopsByRole;

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
