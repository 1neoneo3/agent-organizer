import type { DatabaseSync } from "node:sqlite";
import { getActiveProcesses } from "../spawner/process-manager.js";
import type { WsHub } from "../ws/hub.js";

/**
 * Orphan recovery: find tasks marked as in_progress but with no active process.
 * Runs periodically to handle crashes or unclean shutdowns.
 */
export function startOrphanRecovery(db: DatabaseSync, ws: WsHub, intervalMs = 60_000): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const active = getActiveProcesses();
    const inProgress = db.prepare(
      "SELECT id, assigned_agent_id FROM tasks WHERE status = 'in_progress'"
    ).all() as Array<{ id: string; assigned_agent_id: string | null }>;

    for (const task of inProgress) {
      if (!active.has(task.id)) {
        const now = Date.now();
        db.prepare(
          "UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?"
        ).run(now, now, task.id);
        db.prepare(
          "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', 'Task cancelled by orphan recovery (no active process)')"
        ).run(task.id);

        if (task.assigned_agent_id) {
          db.prepare(
            "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?"
          ).run(now, task.assigned_agent_id);
          ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
        }

        ws.broadcast("task_update", { id: task.id, status: "cancelled" });
      }
    }
  }, intervalMs);
}
