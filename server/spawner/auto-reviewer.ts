import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import type { CacheService } from "../cache/cache-service.js";
import { getMaxReviewCount, hasExhaustedReviewBudget } from "../domain/review-rules.js";

/**
 * Trigger automatic code review when a task transitions to "pr_review".
 *
 * Guards:
 *  - auto_review setting must be enabled
 *  - review_count must be 0 (prevents infinite loops)
 *  - an idle review agent must be available
 */
export async function triggerAutoReview(
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

  // Check auto_review setting
  const autoReview = getSetting(db, "auto_review") ?? "true";
  if (autoReview !== "true") {
    logSystem(db, currentTask.id, "Auto review skipped: disabled in settings");
    return;
  }

  // Loop prevention: promote to human_review when review_count reaches the
  // configured max. The task must NOT be returned to inbox (periodic dispatch
  // would re-pick it and create an infinite loop) and must NOT silently stay
  // in pr_review (the task would stagnate with no visible action signal).
  //
  // Matches the pattern in auto-qa.ts: exhausted automatic attempts hand off
  // to a human via the human_review status, which is a terminal state waiting
  // for manual action.
  const maxReviewCount = getMaxReviewCount(db);
  if (hasExhaustedReviewBudget(currentTask, maxReviewCount)) {
    const now = Date.now();
    db.prepare("UPDATE tasks SET status = 'human_review', updated_at = ? WHERE id = ?").run(now, currentTask.id);
    logSystem(
      db,
      currentTask.id,
      `Auto review stopped: review_count (${currentTask.review_count}) reached max (${maxReviewCount}). Moving to human_review — automatic review attempts exhausted, manual action required.`,
    );
    ws.broadcast("task_update", { id: currentTask.id, status: "human_review" });
    return;
  }

  // Find a suitable review agent
  const reviewer = findReviewAgent(db, currentTask.assigned_agent_id);
  if (!reviewer) {
    logSystem(db, currentTask.id, "Auto review skipped: no idle review agent available");
    return;
  }

  // Increment review_count before spawning to mark as "review in progress"
  const now = Date.now();
  db.prepare("UPDATE tasks SET review_count = review_count + 1, updated_at = ? WHERE id = ?").run(now, currentTask.id);

  // Refresh task with updated review_count
  const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(currentTask.id) as Task | undefined;
  if (!freshTask) {
    return;
  }

  logSystem(db, currentTask.id, `Auto review started: agent="${reviewer.name}" (${reviewer.id})`);
  ws.broadcast("cli_output", [{ task_id: currentTask.id, kind: "system", message: `[Auto Review] Starting review with agent: ${reviewer.name}` }], { taskId: currentTask.id });

  // Lazy import to break circular dependency (auto-reviewer <-> process-manager)
  const { spawnAgent } = await import("./process-manager.js");
  spawnAgent(db, ws, reviewer, freshTask, { cache });
}

/**
 * Find an idle agent suitable for code review.
 *
 * Priority:
 *  1. Idle agent with role "code_reviewer" (excluding the implementer)
 *  2. Any idle worker agent (excluding the implementer)
 */
function findReviewAgent(
  db: DatabaseSync,
  implementerAgentId: string | null,
): Agent | undefined {
  // Try code_reviewer role first
  const reviewerByRole = db.prepare(
    "SELECT * FROM agents WHERE role = 'code_reviewer' AND status = 'idle' AND id != ? LIMIT 1"
  ).get(implementerAgentId ?? "") as Agent | undefined;

  if (reviewerByRole) return reviewerByRole;

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
