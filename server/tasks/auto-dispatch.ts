import type { DatabaseSync } from "node:sqlite";
import { spawnAgent as defaultSpawnAgent } from "../spawner/process-manager.js";
import { handleSpawnFailure } from "../spawner/spawn-failures.js";
import type { Agent, Task } from "../types/runtime.js";
import type { WsHub } from "../ws/hub.js";
import { pickTaskUpdate } from "../ws/update-payloads.js";
import { getMaxReviewCount, hasExhaustedReviewBudget } from "../domain/review-rules.js";
import { resolveImplementerAgentForExecution } from "../domain/implementer-agent.js";
import { loadProjectWorkflow } from "../workflow/loader.js";
import { resolveActiveStages } from "../workflow/stage-pipeline.js";

interface AutoDispatchOptions {
  autoAssign: boolean;
  autoRun: boolean;
  spawnAgent?: typeof defaultSpawnAgent;
}

export function pickIdleAgent(db: DatabaseSync): Agent | undefined {
  return db.prepare(
    `SELECT * FROM agents
     WHERE status = 'idle' AND current_task_id IS NULL AND agent_type = 'worker'
     ORDER BY stats_tasks_done ASC, updated_at ASC
     LIMIT 1`
  ).get() as Agent | undefined;
}

function getFirstActiveStage(db: DatabaseSync, task: Task): string | undefined {
  let workflow = null;
  if (task.project_path) {
    try {
      workflow = loadProjectWorkflow(task.project_path);
    } catch {
      workflow = null;
    }
  }
  return resolveActiveStages(db, workflow, task.task_size, task.id)[0];
}

export function autoDispatchTask(
  db: DatabaseSync,
  ws: WsHub,
  taskId: string,
  options: AutoDispatchOptions,
): Task | undefined {
  const spawnAgent = options.spawnAgent ?? defaultSpawnAgent;
  let task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
  if (!task) return undefined;

  // Skip tasks that were returned to inbox after hitting review_count max.
  // Without this guard, periodic dispatch re-picks them and creates an infinite
  // pr_review → inbox → dispatch → pr_review loop with repeated Telegram notifications.
  if (task.status === "inbox" && task.review_count > 0) {
    if (hasExhaustedReviewBudget(task, getMaxReviewCount(db))) {
      return task;
    }
  }

  const firstStage = getFirstActiveStage(db, task);

  if (!task.assigned_agent_id && options.autoAssign) {
    const resolution = firstStage === "refinement"
      ? undefined
      : resolveImplementerAgentForExecution(db, task.assigned_agent_id, undefined, { taskId: task.id });
    const idleAgent = resolution?.ok ? resolution.agent : pickIdleAgent(db);
    if (idleAgent) {
      const assignTs = Date.now();
      db.prepare("UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?").run(idleAgent.id, assignTs, task.id);
      task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined;
      if (task) {
        ws.broadcast("task_update", pickTaskUpdate(task, ["assigned_agent_id", "updated_at"]));
      }
    }
  }

  if (!task?.assigned_agent_id || !options.autoRun || task.status === "in_progress") {
    return task;
  }

  const resolution = firstStage === "refinement"
    ? undefined
    : resolveImplementerAgentForExecution(db, task.assigned_agent_id, undefined, { taskId: task.id });
  const agent = resolution?.ok
    ? resolution.agent
    : db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as Agent | undefined;
  if (!agent || agent.status !== "idle" || agent.current_task_id !== null) {
    return task;
  }
  if (task.assigned_agent_id !== agent.id) {
    const assignTs = Date.now();
    db.prepare("UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?").run(agent.id, assignTs, task.id);
    task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined;
    if (!task) return undefined;
    ws.broadcast("task_update", pickTaskUpdate(task, ["assigned_agent_id", "updated_at"]));
  }

  // Fire-and-forget: spawnAgent is async (awaits the Explore Phase) but
  // autoDispatchTask returns synchronously so callers can read the updated
  // task row immediately.
  const spawnResult = spawnAgent(db, ws, agent, task);
  if (spawnResult && typeof (spawnResult as Promise<unknown>).catch === "function") {
    (spawnResult as Promise<unknown>).catch((err) => {
      const handled = handleSpawnFailure(db, ws, task.id, err, {
        source: "Auto dispatch",
      });
      if (handled.handled) {
        return;
      }
      console.error(`[auto-dispatch] spawnAgent failed for task ${task.id}:`, err);
    });
  }
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined;
}
