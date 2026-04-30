import type { DatabaseSync } from "node:sqlite";
import { spawnAgent as defaultSpawnAgent } from "../spawner/process-manager.js";
import { handleSpawnFailure } from "../spawner/spawn-failures.js";
import { resolveStageAgentOverride } from "../spawner/stage-agent-resolver.js";
import type { Agent, Task } from "../types/runtime.js";
import type { WsHub } from "../ws/hub.js";
import { pickTaskUpdate } from "../ws/update-payloads.js";
import { getMaxReviewCount, hasExhaustedReviewBudget } from "../domain/review-rules.js";
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
     WHERE status = 'idle' AND current_task_id IS NULL
     ORDER BY stats_tasks_done ASC, updated_at ASC
     LIMIT 1`
  ).get() as Agent | undefined;
}

/**
 * Pick an idle agent for an inbox task, honouring the stage-specific
 * `refinement_agent_role` / `refinement_agent_model` settings before
 * falling back to the legacy round-robin {@link pickIdleAgent}.
 *
 * The override only applies when the task's first active workflow stage
 * is `refinement` — for workflows that skip refinement (e.g. small tasks
 * or `default_enable_refinement = false`), the override is not relevant
 * and the legacy fallback is used. This mirrors the dispatcher path in
 * `server/dispatch/auto-dispatcher.ts` (`resolveRefinementAgentForInbox`)
 * so both entry points (POST /tasks creation and the periodic dispatch
 * tick) make the same assignment choice.
 *
 * If no agent matches the role/model filter, or the matched agent is no
 * longer idle, the function silently falls back to `pickIdleAgent` to
 * preserve the existing throughput guarantee that a fresh task never
 * waits for a specific worker.
 */
export function pickInboxAgent(db: DatabaseSync, task: Task): Agent | undefined {
  const override = resolveStageAgentOverride(
    db,
    "refinement_agent_role",
    "refinement_agent_model",
  );
  if (override && override.status === "idle" && !override.current_task_id) {
    let workflow = null;
    if (task.project_path) {
      try {
        workflow = loadProjectWorkflow(task.project_path);
      } catch {
        workflow = null;
      }
    }
    const activeStages = resolveActiveStages(db, workflow, task.task_size, task.id);
    if (activeStages[0] === "refinement") {
      return override;
    }
  }
  return pickIdleAgent(db);
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

  if (!task.assigned_agent_id && options.autoAssign) {
    const idleAgent = pickInboxAgent(db, task);
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

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as Agent | undefined;
  if (!agent || agent.status !== "idle") {
    return task;
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
