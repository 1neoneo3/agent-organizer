import type { DatabaseSync } from "node:sqlite";
import { spawnAgent as defaultSpawnAgent } from "../spawner/process-manager.js";
import { handleSpawnFailure } from "../spawner/spawn-failures.js";
import { resolveStageAgentSelection } from "../spawner/stage-agent-resolver.js";
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
 * `refinement_agent_role` / `refinement_agent_model` settings as a
 * hard constraint when the task's first active stage is `refinement`.
 *
 * Behaviour matrix (mirrors the periodic dispatcher in
 * `server/dispatch/auto-dispatcher.ts`):
 *
 *  - First active stage is NOT `refinement` → the stage override does
 *    not apply; fall through to the legacy round-robin
 *    {@link pickIdleAgent}. This covers small tasks and projects with
 *    `default_enable_refinement = false`.
 *  - First active stage IS `refinement` and override is unconfigured
 *    (both filters empty) → fall through to {@link pickIdleAgent}.
 *  - First active stage IS `refinement` and override is configured but
 *    no idle worker matches → return `undefined`. The task stays in
 *    inbox and the next periodic dispatch tick retries. We deliberately
 *    do NOT fall back to a non-matching worker: the user configured
 *    the override as a constraint, and silently dispatching a fresh
 *    task to the wrong worker just because a matching one is busy
 *    would defeat the purpose of the setting.
 *  - First active stage IS `refinement` and override matches → return
 *    the matching agent.
 */
export function pickInboxAgent(db: DatabaseSync, task: Task): Agent | undefined {
  let workflow = null;
  if (task.project_path) {
    try {
      workflow = loadProjectWorkflow(task.project_path);
    } catch {
      workflow = null;
    }
  }
  const activeStages = resolveActiveStages(db, workflow, task.task_size, task.id);
  if (activeStages[0] !== "refinement") {
    return pickIdleAgent(db);
  }

  const result = resolveStageAgentSelection(
    db,
    "refinement_agent_role",
    "refinement_agent_model",
  );
  switch (result.status) {
    case "unconfigured":
      return pickIdleAgent(db);
    case "configured_match":
      return result.agent;
    case "configured_no_match":
    case "configured_no_match_in_pool":
      // Configured but no matching idle worker — leave the task in
      // inbox so the periodic dispatcher can retry. autoDispatchTask
      // will not assign anyone this round.
      return undefined;
  }
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
