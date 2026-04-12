import type { DatabaseSync } from "node:sqlite";
import { getActiveProcesses, getPendingInteractivePrompt, clearPendingInteractivePrompt } from "../spawner/process-manager.js";
import type { WsHub } from "../ws/hub.js";
import type { CacheService } from "../cache/cache-service.js";
import { AUTO_STAGES, type AutoStage } from "../domain/task-status.js";

const INTERACTIVE_PROMPT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// Orphan recovery thresholds for stages where an auto-agent should always be
// running (auto-reviewer, auto-qa, auto-test-gen, auto-ci-check). Tasks
// whose last_heartbeat_at is older than this are treated as stuck.
const AUTO_STAGE_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// Grace period after server start during which auto-stage recovery is
// skipped. Gives the server time to restart in-flight processes and the
// process-manager time to repopulate its active-process map.
const STARTUP_GRACE_MS = 2 * 60 * 1000; // 2 minutes

// The canonical list of auto-stages lives in `domain/task-status.ts`. When a
// task sits in one of these with a stale heartbeat, we promote it to
// human_review so it does not stagnate forever.

interface AutoStageRow {
  id: string;
  status: AutoStage;
  assigned_agent_id: string | null;
  last_heartbeat_at: number | null;
  updated_at: number;
}

/**
 * Orphan recovery: find tasks marked as in_progress but with no active process,
 * and find tasks stuck in an auto-stage (pr_review / qa_testing /
 * test_generation / ci_check) whose heartbeat has gone stale.
 *
 * Runs periodically to handle crashes or unclean shutdowns.
 * Skips tasks with a pending interactive prompt (unless timed out).
 */
export function startOrphanRecovery(
  db: DatabaseSync,
  ws: WsHub,
  cache?: CacheService,
  intervalMs = 60_000,
): ReturnType<typeof setInterval> {
  const startedAt = Date.now();

  return setInterval(() => {
    const active = getActiveProcesses();

    recoverInProgressOrphans(db, ws, cache, active);
    recoverStuckAutoStages(db, ws, cache, active, startedAt);
  }, intervalMs);
}

export function recoverInProgressOrphans(
  db: DatabaseSync,
  ws: WsHub,
  cache: CacheService | undefined,
  active: Map<string, unknown> | Set<string>,
): void {
  // Recover both in_progress and refinement orphans
  const orphanCandidates = db.prepare(
    "SELECT id, status, assigned_agent_id, refinement_plan FROM tasks WHERE status IN ('in_progress', 'refinement')",
  ).all() as Array<{ id: string; status: string; assigned_agent_id: string | null; refinement_plan: string | null }>;

  for (const task of orphanCandidates) {
    if (hasActive(active, task.id)) continue;

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
        "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', 'Interactive prompt timed out after 2 hours')",
      ).run(task.id);
      ws.broadcast("interactive_prompt_resolved", { task_id: task.id });
    }

    const now = Date.now();

    // Refinement orphan with a plan: stamp completed_at so UI shows
    // approve/reject buttons. The plan is already saved; only the
    // process died before finalization could run.
    if (task.status === "refinement" && task.refinement_plan) {
      const result = db.prepare(
        "UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ? AND status = 'refinement' AND completed_at IS NULL",
      ).run(now, now, task.id);
      if (result.changes === 0) continue;

      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
      ).run(task.id, "Refinement plan ready (recovered by orphan recovery — agent process exited before finalization).");

      if (task.assigned_agent_id) {
        db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?",
        ).run(now, task.assigned_agent_id);
        ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
      }

      if (cache) { cache.invalidatePattern("tasks:*"); cache.del("agents:all"); }
      ws.broadcast("task_update", { id: task.id, status: "refinement", completed_at: now });
      continue;
    }

    // in_progress or refinement without plan: return to inbox
    const result = db.prepare(
      "UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ? AND status = ?",
    ).run(now, task.id, task.status);
    if (result.changes === 0) continue;

    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
    ).run(task.id, `Task returned to inbox by orphan recovery (no active process, was ${task.status}). Will be re-dispatched automatically.`);

    if (task.assigned_agent_id) {
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?",
      ).run(now, task.assigned_agent_id);
      ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
    }

    if (cache) { cache.invalidatePattern("tasks:*"); cache.del("agents:all"); }
    ws.broadcast("task_update", { id: task.id, status: "inbox" });
  }
}

export function recoverStuckAutoStages(
  db: DatabaseSync,
  ws: WsHub,
  cache: CacheService | undefined,
  active: Map<string, unknown> | Set<string>,
  startedAt: number,
): void {
  // Skip during the startup grace window so in-flight processes can recover
  // naturally and the active-process map gets a chance to repopulate.
  if (Date.now() - startedAt < STARTUP_GRACE_MS) return;

  const staleThreshold = Date.now() - AUTO_STAGE_STALE_THRESHOLD_MS;
  const placeholders = AUTO_STAGES.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, status, assigned_agent_id, last_heartbeat_at, updated_at
       FROM tasks
      WHERE status IN (${placeholders})
        AND COALESCE(last_heartbeat_at, updated_at) < ?`,
  ).all(...AUTO_STAGES, staleThreshold) as unknown as AutoStageRow[];

  for (const task of rows) {
    // If a live process is working on the task, let it finish.
    if (hasActive(active, task.id)) continue;

    const now = Date.now();
    // Atomic UPDATE: only act if the task is still in the same auto-stage.
    // This guards against racing with a process that is about to transition
    // the task on its own.
    const result = db.prepare(
      "UPDATE tasks SET status = 'human_review', updated_at = ? WHERE id = ? AND status = ?",
    ).run(now, task.id, task.status);
    if (result.changes === 0) continue;

    const stalenessSource = task.last_heartbeat_at !== null ? "heartbeat" : "updated_at";
    const ageSeconds = Math.floor((now - (task.last_heartbeat_at ?? task.updated_at)) / 1000);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
    ).run(
      task.id,
      `Task promoted to human_review by orphan recovery: stuck in ${task.status} with no active process, ` +
        `${stalenessSource} age ${ageSeconds}s (> ${Math.floor(AUTO_STAGE_STALE_THRESHOLD_MS / 1000)}s threshold).`,
    );

    if (task.assigned_agent_id) {
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ? AND current_task_id = ?",
      ).run(now, task.assigned_agent_id, task.id);
      ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
    }

    if (cache) {
      cache.invalidatePattern("tasks:*");
      cache.del("agents:all");
    }
    ws.broadcast("task_update", { id: task.id, status: "human_review" });
  }
}

function hasActive(active: Map<string, unknown> | Set<string>, id: string): boolean {
  if (active instanceof Map) return active.has(id);
  return active.has(id);
}
