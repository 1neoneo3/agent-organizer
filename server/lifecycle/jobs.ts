import type { DatabaseSync } from "node:sqlite";
import { getActiveProcesses, getPendingInteractivePrompt, clearPendingInteractivePrompt } from "../spawner/process-manager.js";
import type { WsHub } from "../ws/hub.js";
import type { CacheService } from "../cache/cache-service.js";

const INTERACTIVE_PROMPT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Orphan recovery: find tasks marked as in_progress but with no active process.
 * Runs periodically to handle crashes or unclean shutdowns.
 * Skips tasks with a pending interactive prompt (unless timed out).
 */
export function startOrphanRecovery(db: DatabaseSync, ws: WsHub, cache?: CacheService, intervalMs = 60_000): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const active = getActiveProcesses();
    const inProgress = db.prepare(
      "SELECT id, assigned_agent_id FROM tasks WHERE status = 'in_progress'"
    ).all() as Array<{ id: string; assigned_agent_id: string | null }>;

    for (const task of inProgress) {
      if (!active.has(task.id)) {
        // Skip tasks awaiting interactive prompt (unless timed out)
        const pending = getPendingInteractivePrompt(task.id);
        if (pending) {
          const elapsed = Date.now() - pending.createdAt;
          if (elapsed < INTERACTIVE_PROMPT_TIMEOUT_MS) {
            continue; // Still waiting for user response
          }
          // Timed out — clear and cancel
          clearPendingInteractivePrompt(task.id, db);
          db.prepare(
            "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', 'Interactive prompt timed out after 2 hours')"
          ).run(task.id);
          ws.broadcast("interactive_prompt_resolved", { task_id: task.id });
        }

        const now = Date.now();
        db.prepare(
          "UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?"
        ).run(now, task.id);
        db.prepare(
          "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', 'Task returned to inbox by orphan recovery (no active process). Will be re-dispatched automatically.')"
        ).run(task.id);

        if (task.assigned_agent_id) {
          db.prepare(
            "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?"
          ).run(now, task.assigned_agent_id);
          ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
        }

        if (cache) {
          cache.invalidatePattern("tasks:*");
          cache.del("agents:all");
        }
        ws.broadcast("task_update", { id: task.id, status: "inbox" });
      }
    }
  }, intervalMs);
}
