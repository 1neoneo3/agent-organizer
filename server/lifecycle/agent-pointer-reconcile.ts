import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";

// Task statuses where an `agents.current_task_id` pointer is no longer
// load-bearing. A `working` agent pointing at one of these has nothing to
// drive and should be released back to `idle`.
const RELEASABLE_TASK_STATUSES = new Set(["done", "cancelled"]);

interface AgentPointerRow {
  id: string;
  agent_status: "idle" | "working" | "offline";
  current_task_id: string | null;
  // NULL when the LEFT JOIN finds no matching task (deleted task pointer).
  task_status: string | null;
}

export interface ReconcileResult {
  released: Array<{ id: string; reason: "missing" | "done" | "cancelled" | "null_pointer" }>;
  cleared: Array<{ id: string; reason: "idle_pointer" | "missing" | "done" | "cancelled" }>;
}

/**
 * Find stale agent task pointers and normalize them:
 *   - `working` agents whose task is missing / terminal / NULL are released.
 *   - `idle` agents should never hold a current_task_id, so any non-NULL
 *     pointer is cleared. This keeps `pickIdleAgent()` from skipping an
 *     otherwise reusable idle agent.
 *
 * Releases when the task pointer is:
 *   - NULL                  (structurally invalid: working without a task)
 *   - missing               (task row was deleted out from under the agent)
 *   - in `done`/`cancelled` (terminal — nothing left to drive)
 *
 * Skips agents whose pointed-to task currently has a live process in
 * `activeTaskIds` so a healthy run is never preempted.
 */
export function reconcileStaleAgentPointers(
  db: DatabaseSync,
  ws: WsHub,
  options: { activeTaskIds?: ReadonlySet<string> | Map<string, unknown> } = {},
): ReconcileResult {
  const active = options.activeTaskIds;
  const rows = db
    .prepare(
      `SELECT a.id AS id,
              a.status AS agent_status,
              a.current_task_id AS current_task_id,
              t.status AS task_status
         FROM agents a
         LEFT JOIN tasks t ON t.id = a.current_task_id
        WHERE a.status = 'working'
           OR (a.status = 'idle' AND a.current_task_id IS NOT NULL)`,
    )
    .all() as unknown as AgentPointerRow[];

  const released: ReconcileResult["released"] = [];
  const cleared: ReconcileResult["cleared"] = [];
  const now = Date.now();

  for (const row of rows) {
    const taskId = row.current_task_id;
    if (row.agent_status === "idle" && taskId !== null) {
      const clearReason =
        row.task_status === null || row.task_status === "done" || row.task_status === "cancelled"
          ? row.task_status ?? "missing"
          : "idle_pointer";
      const result = db.prepare(
        "UPDATE agents SET current_task_id = NULL, updated_at = ? WHERE id = ? AND status = 'idle' AND current_task_id = ?",
      ).run(now, row.id, taskId);
      if (result.changes === 0) continue;

      cleared.push({ id: row.id, reason: clearReason });
      ws.broadcast("agent_status", { id: row.id, status: "idle", current_task_id: null });
      continue;
    }

    // If a live process still owns this task, the working pointer is real.
    if (taskId && hasActive(active, taskId)) continue;

    let reason: ReconcileResult["released"][number]["reason"] | null = null;
    if (taskId === null) reason = "null_pointer";
    else if (row.task_status === null) reason = "missing";
    else if (row.task_status === "done") reason = "done";
    else if (row.task_status === "cancelled") reason = "cancelled";
    else if (RELEASABLE_TASK_STATUSES.has(row.task_status)) {
      // Defensive: keep the set as the source of truth even if the explicit
      // checks above ever drift.
      reason = row.task_status as "done" | "cancelled";
    }
    if (!reason) continue;

    const result = db.prepare(
      "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ? AND status = 'working'",
    ).run(now, row.id);
    if (result.changes === 0) continue;

    released.push({ id: row.id, reason });
    ws.broadcast("agent_status", { id: row.id, status: "idle", current_task_id: null });
  }

  return { released, cleared };
}

/**
 * Clear every idle/working agent whose `current_task_id` points at the given
 * task. Called from `DELETE /tasks/:id` so the agent does not stay `working`
 * or appear `idle` while carrying a stale pointer. The DELETE itself does not
 * cascade — `agents.current_task_id` has no FK constraint on purpose, so we
 * clean it up here explicitly.
 */
export function releaseAgentsForDeletedTask(
  db: DatabaseSync,
  ws: WsHub,
  taskId: string,
): string[] {
  const agents = db
    .prepare("SELECT id, status FROM agents WHERE status IN ('idle', 'working') AND current_task_id = ?")
    .all(taskId) as Array<{ id: string; status: "idle" | "working" }>;
  if (agents.length === 0) return [];

  const now = Date.now();
  const released: string[] = [];
  for (const agent of agents) {
    const statement = agent.status === "working"
      ? "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ? AND status = 'working' AND current_task_id = ?"
      : "UPDATE agents SET current_task_id = NULL, updated_at = ? WHERE id = ? AND status = 'idle' AND current_task_id = ?";
    const result = db.prepare(statement).run(now, agent.id, taskId);
    if (result.changes === 0) continue;
    released.push(agent.id);
    ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });
  }
  return released;
}

function hasActive(
  active: ReadonlySet<string> | Map<string, unknown> | undefined,
  id: string,
): boolean {
  if (!active) return false;
  if (active instanceof Map) return active.has(id);
  return active.has(id);
}
