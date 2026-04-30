import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import { resolveStageAgentOverride } from "./stage-agent-resolver.js";

/**
 * Auto Human Review.
 *
 * When a task lands in `human_review`, the legacy behavior is to wait
 * for a human approve/reject decision. With the `auto_human_review`
 * setting enabled, an agent is spawned to grade the work against the
 * task requirements just like the pr_review reviewer panel would. The
 * verdict drives the next transition:
 *
 *   - `[REVIEW:code:PASS]`           → task advances to `done`
 *   - `[REVIEW:code:NEEDS_CHANGES]`  → task bounces back to `in_progress`
 *
 * Loop budget is tracked via system logs (each `Auto Human Review
 * started` entry counts as one iteration) and bounded by the
 * `human_review_count` setting. When the cap is hit the loop stops and
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

  const autoHumanReview = getSetting(db, "auto_human_review") ?? "false";
  if (autoHumanReview !== "true") {
    logSystem(db, currentTask.id, "Auto Human Review skipped: disabled in settings");
    return;
  }

  const maxIterations = resolveMaxIterations(db);
  const iterations = countAutoHumanReviewIterations(db, currentTask.id);
  if (iterations >= maxIterations) {
    logSystem(
      db,
      currentTask.id,
      `Auto Human Review stopped: iterations (${iterations}) reached max (${maxIterations}). Leaving task in human_review for manual decision.`,
    );
    return;
  }

  const reviewer = findHumanReviewAgent(db, currentTask.assigned_agent_id);
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
      "SELECT COUNT(*) AS cnt FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE ?",
    )
    .get(taskId, `${STARTED_LOG_PREFIX}%`) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function resolveMaxIterations(db: DatabaseSync): number {
  const raw = getSetting(db, "human_review_count");
  if (!raw) return DEFAULT_HUMAN_REVIEW_COUNT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_HUMAN_REVIEW_COUNT;
  return parsed;
}

/**
 * Pick an idle reviewer for the human_review auto-loop. Reuses the
 * `review_agent_*` settings overrides so operators can constrain the
 * pool the same way they do for pr_review. Falls back to a code_reviewer
 * role agent, then any idle worker — the implementer is always excluded
 * to prevent self-review.
 */
export function findHumanReviewAgent(
  db: DatabaseSync,
  implementerAgentId: string | null,
): Agent | undefined {
  const excludeId = implementerAgentId ?? "";

  const override = resolveStageAgentOverride(
    db,
    "review_agent_role",
    "review_agent_model",
    [excludeId],
  );
  if (override) return override;

  const codeReviewer = db
    .prepare(
      "SELECT * FROM agents WHERE role = 'code_reviewer' AND status = 'idle' AND id != ? LIMIT 1",
    )
    .get(excludeId) as Agent | undefined;
  if (codeReviewer) return codeReviewer;

  const anyIdle = db
    .prepare(
      "SELECT * FROM agents WHERE status = 'idle' AND agent_type = 'worker' AND id != ? LIMIT 1",
    )
    .get(excludeId) as Agent | undefined;
  return anyIdle;
}

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function logSystem(db: DatabaseSync, taskId: string, message: string): void {
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage) VALUES (?, 'system', ?, 'human_review')",
  ).run(taskId, message);
}
