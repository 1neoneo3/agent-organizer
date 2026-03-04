import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import type { CacheService } from "../cache/cache-service.js";

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
  // Check auto_review setting
  const autoReview = getSetting(db, "auto_review") ?? "true";
  if (autoReview !== "true") {
    logSystem(db, task.id, "Auto review skipped: disabled in settings");
    return;
  }

  // Loop prevention: skip if already reviewed
  if (task.review_count > 0) {
    logSystem(db, task.id, "Auto review skipped: already reviewed (review_count > 0)");
    return;
  }

  // Find a suitable review agent
  const reviewer = findReviewAgent(db, task.assigned_agent_id);
  if (!reviewer) {
    logSystem(db, task.id, "Auto review skipped: no idle review agent available");
    return;
  }

  // Increment review_count before spawning to mark as "review in progress"
  const now = Date.now();
  db.prepare("UPDATE tasks SET review_count = review_count + 1, updated_at = ? WHERE id = ?").run(now, task.id);

  // Refresh task with updated review_count
  const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;

  logSystem(db, task.id, `Auto review started: agent="${reviewer.name}" (${reviewer.id})`);
  ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: `[Auto Review] Starting review with agent: ${reviewer.name}` }]);

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
