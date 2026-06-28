import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import { getTaskSetting } from "../domain/task-settings.js";
import {
  getLatestHumanReviewAutoMarker,
  recordHumanReviewAutoMarker,
} from "../domain/human-review-auto.js";
import { resolveStageAgentSelection } from "./stage-agent-resolver.js";

/**
 * Auto Human Review.
 *
 * When a task lands in `human_review`, the legacy behavior is to wait
 * for a human approve/reject decision. With the `auto_human_review`
 * setting enabled, an agent is spawned to grade the work against the
 * task requirements just like the pr_review reviewer panel would. The
 * verdict drives the next transition:
 *
 *   - `[REVIEW:code:PASS]`           → task advances according to `human_review_auto_approve`
 *   - `[REVIEW:code:NEEDS_CHANGES]`  → task bounces back to `in_progress`
 *
 * Loop budget is tracked via system logs (each `Auto Human Review
 * started` entry counts as one iteration) and bounded by the
 * `human_review_auto_count` setting. When the cap is hit the loop stops and
 * the task stays in `human_review` so a real human can take over.
 */
export const HUMAN_REVIEW_PANEL_ROLE = "code" as const;
const STARTED_LOG_PREFIX = "Auto Human Review started";

const DEFAULT_HUMAN_REVIEW_COUNT = 2;

export async function triggerAutoHumanReview(
  db: DatabaseSync,
  ws: WsHub,
  task: Task,
): Promise<void> {
  const existingTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined;
  if (!existingTask) return;

  const currentTask = existingTask;

  if (currentTask.status !== "human_review") {
    // Task drifted to another stage between the trigger schedule and the
    // actual call (e.g. user reset to inbox, or stage-pipeline rerouted).
    // Skip silently — re-entering would mis-tag stage and waste a worker.
    return;
  }

  const autoHumanReview = getSetting(db, "auto_human_review", currentTask.id) ?? "false";
  if (autoHumanReview !== "true") {
    logSystem(db, currentTask.id, "Auto Human Review skipped: disabled in settings");
    return;
  }

  const latestMarker = getLatestHumanReviewAutoMarker(db, currentTask.id);
  if (latestMarker === "AWAITING_HUMAN" || latestMarker === "EXHAUSTED") {
    return;
  }

  const maxIterations = resolveMaxIterations(db, currentTask.id);
  const iterations = countAutoHumanReviewIterations(db, currentTask.id);
  if (iterations >= maxIterations) {
    const now = Date.now();
    recordHumanReviewAutoMarker(db, currentTask.id, "EXHAUSTED");
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, currentTask.id);
    logSystem(
      db,
      currentTask.id,
      `Auto Human Review stopped: iterations (${iterations}) reached max (${maxIterations}). Leaving task in human_review for manual decision.`,
    );
    ws.broadcast("task_update", {
      id: currentTask.id,
      updated_at: now,
      human_review_auto_status: "exhausted",
    });
    return;
  }

  const reviewerDecision = resolveHumanReviewAgent(db, currentTask.assigned_agent_id);
  if (reviewerDecision.kind === "skip") {
    logSystem(db, currentTask.id, reviewerDecision.reason);
    ws.broadcast(
      "cli_output",
      [{ task_id: currentTask.id, kind: "system", message: `[Auto Human Review] ${reviewerDecision.reason}` }],
      { taskId: currentTask.id },
    );
    return;
  }

  const reviewer = reviewerDecision.agent;
  if (!reviewer) {
    logSystem(db, currentTask.id, "Auto Human Review skipped: no idle review agent available");
    return;
  }

  const expectedRoles = [HUMAN_REVIEW_PANEL_ROLE];
  // Tag the panel marker on the human_review stage explicitly so the
  // stage-pipeline aggregator finds the expected role list scoped to
  // this run (filter is `created_at >= started_at`).
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage, agent_id) VALUES (?, 'system', ?, 'human_review', ?)",
  ).run(currentTask.id, `[REVIEWER_PANEL:${expectedRoles.join(",")}]`, currentTask.assigned_agent_id ?? null);

  logSystem(
    db,
    currentTask.id,
    `${STARTED_LOG_PREFIX}: agent="${reviewer.name}" (${reviewer.id})`,
  );
  recordHumanReviewAutoMarker(db, currentTask.id, "STARTED", `agent="${reviewer.name}" (${reviewer.id})`);
  ws.broadcast(
    "cli_output",
    [
      {
        task_id: currentTask.id,
        kind: "system",
        message: `[Auto Human Review] Starting reviewer: ${reviewer.name}`,
      },
    ],
    { taskId: currentTask.id },
  );

  // Lazy import to break circular dependency with process-manager.
  const { spawnAgent } = await import("./process-manager.js");
  const { handleSpawnFailure } = await import("./spawn-failures.js");

  spawnAgent(db, ws, reviewer, currentTask, {
    reviewerRole: HUMAN_REVIEW_PANEL_ROLE,
  }).catch((err) => {
    const handled = handleSpawnFailure(db, ws, currentTask.id, err, {
      source: "Auto Human Review",
    });
    if (handled.handled) return;
    console.error(`[auto-human-reviewer] spawn failed for task ${currentTask.id}:`, err);
  });
}

export function countAutoHumanReviewIterations(
  db: DatabaseSync,
  taskId: string,
): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM task_logs WHERE task_id = ? AND kind = 'system' AND (message LIKE ? OR message LIKE ?)",
    )
    .get(taskId, `${STARTED_LOG_PREFIX}%`, "[HUMAN_REVIEW_AUTO:STARTED]%") as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function resolveMaxIterations(db: DatabaseSync, taskId?: string | null): number {
  const raw =
    getSetting(db, "human_review_auto_count", taskId) ??
    getSetting(db, "human_review_count", taskId);
  if (!raw) return DEFAULT_HUMAN_REVIEW_COUNT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_HUMAN_REVIEW_COUNT;
  return Math.min(10, Math.max(1, Math.floor(parsed)));
}

/**
 * Discriminated decision for the human_review auto-run. A configured
 * review_agent_role/model is a hard constraint just like pr_review:
 * fallback to the lifecycle owner or a generic worker would bypass the
 * configured reviewer pool.
 */
export type HumanReviewAgentDecision =
  | { kind: "agent"; agent: Agent | undefined }
  | { kind: "skip"; reason: string };

/**
 * Pick an idle reviewer for the human_review auto-loop. Reuses the
 * `review_agent_*` settings overrides so operators can constrain the
 * pool the same way they do for pr_review. Falls back to a code_reviewer
 * role agent, then any idle worker — the implementer is always excluded
 * to prevent self-review.
 */
export function resolveHumanReviewAgent(
  db: DatabaseSync,
  implementerAgentId: string | null,
): HumanReviewAgentDecision {
  const excludeId = implementerAgentId ?? "";

  const override = resolveStageAgentSelection(
    db,
    "review_agent_role",
    "review_agent_model",
    { excludeIds: [excludeId] },
  );
  if (override.status === "configured_match") {
    return { kind: "agent", agent: override.agent };
  }
  if (override.status === "configured_no_match" || override.status === "configured_no_match_in_pool") {
    return {
      kind: "skip",
      reason:
        "Auto Human Review skipped: review_agent_role/model is configured but no matching idle worker exists; will retry on the next human_review trigger",
    };
  }

  const codeReviewer = db
    .prepare(
      "SELECT * FROM agents WHERE role = 'code_reviewer' AND status = 'idle' AND current_task_id IS NULL AND id != ? LIMIT 1",
    )
    .get(excludeId) as Agent | undefined;
  if (codeReviewer) return { kind: "agent", agent: codeReviewer };

  const anyIdle = db
    .prepare(
      "SELECT * FROM agents WHERE status = 'idle' AND current_task_id IS NULL AND agent_type = 'worker' AND id != ? LIMIT 1",
    )
    .get(excludeId) as Agent | undefined;
  return { kind: "agent", agent: anyIdle };
}

export function findHumanReviewAgent(
  db: DatabaseSync,
  implementerAgentId: string | null,
): Agent | undefined {
  const decision = resolveHumanReviewAgent(db, implementerAgentId);
  return decision.kind === "agent" ? decision.agent : undefined;
}

function getSetting(db: DatabaseSync, key: string, taskId?: string | null): string | undefined {
  return getTaskSetting(db, key, taskId);
}

function logSystem(db: DatabaseSync, taskId: string, message: string): void {
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage) VALUES (?, 'system', ?, 'human_review')",
  ).run(taskId, message);
}
