import type { DatabaseSync } from "node:sqlite";
import { getMaxReviewCount, hasExhaustedReviewBudget } from "../domain/review-rules.js";
import { resolveImplementerAgentForExecution } from "../domain/implementer-agent.js";
import { spawnAgent as defaultSpawnAgent } from "../spawner/process-manager.js";
import { handleSpawnFailure } from "../spawner/spawn-failures.js";
import { resolveStageAgentSelection } from "../spawner/stage-agent-resolver.js";
import type { Agent, Task } from "../types/runtime.js";
import type { WsHub } from "../ws/hub.js";
import { pickTaskUpdate } from "../ws/update-payloads.js";
import { loadProjectWorkflow } from "../workflow/loader.js";
import { resolveActiveStages } from "../workflow/stage-pipeline.js";
import { writeDispatchLog } from "./dispatch-logs.js";

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
     LIMIT 1`,
  ).get() as Agent | undefined;
}

function getActiveStages(db: DatabaseSync, task: Task): ReturnType<typeof resolveActiveStages> {
  let workflow = null;
  if (task.project_path) {
    try {
      workflow = loadProjectWorkflow(task.project_path);
    } catch {
      workflow = null;
    }
  }
  return resolveActiveStages(db, workflow, task.task_size, task.id);
}

function hasCompletedRefinementPlan(task: Task): boolean {
  return !!task.refinement_plan && task.refinement_completed_at != null;
}

function getFirstExecutionStage(db: DatabaseSync, task: Task): string | undefined {
  const activeStages = getActiveStages(db, task);
  if (activeStages[0] === "refinement" && hasCompletedRefinementPlan(task)) {
    return activeStages[1] ?? activeStages[0];
  }
  return activeStages[0];
}

/**
 * Pick an idle agent for an inbox task, honouring the stage-specific
 * `refinement_agent_role` / `refinement_agent_model` settings as a
 * hard constraint when the task's next execution stage is `refinement`.
 */
export interface PickInboxAgentResult {
  agent?: Agent;
  skipReason?: string;
}

export function pickInboxAgent(db: DatabaseSync, task: Task): PickInboxAgentResult {
  const firstExecutionStage = getFirstExecutionStage(db, task);
  if (firstExecutionStage !== "refinement") {
    const resolution = resolveImplementerAgentForExecution(db, task.assigned_agent_id, undefined, {
      taskId: task.id,
    });
    return resolution.ok
      ? { agent: resolution.agent }
      : { skipReason: "skipped: no idle implementer agent is available" };
  }

  const result = resolveStageAgentSelection(
    db,
    "refinement_agent_role",
    "refinement_agent_model",
  );
  switch (result.status) {
    case "unconfigured":
      return { agent: pickIdleAgent(db) };
    case "configured_match":
      return { agent: result.agent };
    case "configured_no_match":
      return {
        skipReason:
          "skipped: refinement_agent_role/model is configured but no matching idle worker exists; will retry next tick",
      };
    case "configured_no_match_in_pool":
      return {
        skipReason:
          "skipped: refinement_agent_role/model match was already taken in this tick; will retry next tick",
      };
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
  // pr_review -> inbox -> dispatch -> pr_review loop with repeated notifications.
  if (task.status === "inbox" && task.review_count > 0) {
    if (hasExhaustedReviewBudget(task, getMaxReviewCount(db))) {
      return task;
    }
  }

  const firstExecutionStage = getFirstExecutionStage(db, task);

  if (!task.assigned_agent_id && options.autoAssign) {
    const selection = pickInboxAgent(db, task);
    if (selection.skipReason) {
      writeDispatchLog(db, ws, task, selection.skipReason);
    }
    const idleAgent = selection.agent;
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

  let agent: Agent | undefined;
  if (firstExecutionStage === "refinement") {
    agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as Agent | undefined;
  } else {
    const resolution = resolveImplementerAgentForExecution(db, task.assigned_agent_id, undefined, {
      taskId: task.id,
    });
    if (!resolution.ok) {
      writeDispatchLog(db, ws, task, "skipped: no idle implementer agent is available");
      return task;
    }
    agent = resolution.agent;
  }

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
