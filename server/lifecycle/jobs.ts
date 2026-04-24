import type { DatabaseSync } from "node:sqlite";
import { getActiveProcesses, getPendingInteractivePrompt, clearPendingInteractivePrompt, spawnAgent as defaultSpawnAgent } from "../spawner/process-manager.js";
import { handleSpawnFailure } from "../spawner/spawn-failures.js";
import type { WsHub } from "../ws/hub.js";
import type { CacheService } from "../cache/cache-service.js";
import { AUTO_STAGES, type AutoStage } from "../domain/task-status.js";
import { ORPHAN_AUTO_RESPAWN_MAX } from "../config/runtime.js";
import type { Agent, Task } from "../types/runtime.js";

const INTERACTIVE_PROMPT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// Orphan recovery thresholds for stages where an auto-agent should always be
// running (auto-reviewer, auto-qa, auto-test-gen). Tasks
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
 * test_generation) whose heartbeat has gone stale.
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

export interface RecoverInProgressOrphansOptions {
  spawnAgent?: typeof defaultSpawnAgent;
  maxAutoRespawn?: number;
}

export function recoverInProgressOrphans(
  db: DatabaseSync,
  ws: WsHub,
  cache: CacheService | undefined,
  active: Map<string, unknown> | Set<string>,
  options: RecoverInProgressOrphansOptions = {},
): void {
  const spawnAgent = options.spawnAgent ?? defaultSpawnAgent;
  const maxAutoRespawn = options.maxAutoRespawn ?? ORPHAN_AUTO_RESPAWN_MAX;

  // Recover both in_progress and refinement orphans
  const orphanCandidates = db.prepare(
    "SELECT id, status, assigned_agent_id, refinement_plan, started_at, auto_respawn_count FROM tasks WHERE status IN ('in_progress', 'refinement')",
  ).all() as Array<{
    id: string;
    status: string;
    assigned_agent_id: string | null;
    refinement_plan: string | null;
    started_at: number | null;
    auto_respawn_count: number;
  }>;

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
        `UPDATE tasks
         SET completed_at = ?,
             refinement_revision_completed_at = CASE
               WHEN refinement_revision_requested_at IS NOT NULL THEN ?
               ELSE refinement_revision_completed_at
             END,
             updated_at = ?
         WHERE id = ? AND status = 'refinement' AND completed_at IS NULL`,
      ).run(now, now, now, task.id);
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
      const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
      ws.broadcast("task_update", freshTask ?? { id: task.id, status: "refinement", completed_at: now });
      continue;
    }

    // in_progress orphan: park the task at in_progress and release the
    // assigned agent. Previously this branch bounced the task all the way
    // back to inbox, which made the auto-dispatcher start a fresh
    // refinement run and lost the entire pr_review → rework loop context.
    // Spec: regressions from pr_review/qa_testing/human_review may
    // land at in_progress but must never slip further back to inbox.
    //
    // Auto-respawn: when the assigned agent is idle (i.e. the previous
    // crash released it) and the task has not exceeded its respawn budget,
    // restart the agent so long-running tasks survive a crash without
    // manual intervention. The budget resets on any forward stage
    // transition (see process-manager close handler) and on manual Run /
    // manual feedback-rework (see routes/tasks.ts), so only truly stuck
    // tasks exhaust it.
    if (task.status === "in_progress") {
      // Evaluate auto-respawn eligibility. A pending interactive prompt
      // that just timed out is cleared above and falls through here as a
      // normal parked task.
      const respawnDecision = evaluateAutoRespawn(db, task, maxAutoRespawn);

      if (respawnDecision.kind === "respawn") {
        if (task.assigned_agent_id) {
          db.prepare(
            "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?",
          ).run(now, task.assigned_agent_id);
          ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
        }
        const nextCount = task.auto_respawn_count + 1;
        db.prepare(
          "UPDATE tasks SET started_at = NULL, completed_at = NULL, auto_respawn_count = ?, updated_at = ? WHERE id = ?",
        ).run(nextCount, now, task.id);
        db.prepare(
          "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
        ).run(
          task.id,
          `Orphan recovery: auto-respawn attempt ${nextCount}/${maxAutoRespawn} with agent "${respawnDecision.agent.name}".`,
        );
        if (cache) { cache.invalidatePattern("tasks:*"); cache.del("agents:all"); }

        const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
        // Fire-and-forget: spawnAgent is async (it awaits Explore Phase
        // before spawning the main CLI process). Failures are logged so
        // the next orphan-recovery tick retries.
        spawnAgent(db, ws, respawnDecision.agent, freshTask, { cache }).catch((error) => {
          const handled = handleSpawnFailure(db, ws, task.id, error, {
            cache,
            source: "Orphan recovery auto-respawn",
          });
          if (handled.handled) {
            return;
          }
          const msg = error instanceof Error ? error.message : String(error);
          db.prepare(
            "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
          ).run(task.id, `Orphan recovery: auto-respawn failed: ${msg}. Will retry on next tick.`);
        });
        continue;
      }

      // Dedupe: once a task is parked at in_progress with no respawn
      // possible, subsequent orphan-recovery ticks (every 60s) should not
      // re-emit the same park log or bump updated_at. We detect an
      // already-parked task by inspecting its most recent system log.
      const lastLog = db.prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY id DESC LIMIT 1",
      ).get(task.id) as { message: string } | undefined;
      const alreadyParked = lastLog?.message.startsWith("Orphan recovery: parked at in_progress") ?? false;
      if (alreadyParked) continue;

      if (task.assigned_agent_id) {
        db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?",
        ).run(now, task.assigned_agent_id);
        ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
      }

      db.prepare(
        "UPDATE tasks SET started_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?",
      ).run(now, task.id);

      const parkReason =
        respawnDecision.kind === "budget_exhausted"
          ? `Orphan recovery: parked at in_progress. Auto-respawn budget exhausted (${task.auto_respawn_count}/${maxAutoRespawn}). Run the task again to resume.`
          : "Orphan recovery: parked at in_progress (did not regress to inbox). Run the task again to resume.";
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
      ).run(task.id, parkReason);
      if (cache) { cache.invalidatePattern("tasks:*"); cache.del("agents:all"); }
      continue;
    }

    // Refinement without plan: legitimately dead start — bounce to inbox so
    // the auto-dispatcher can redo the refinement run from scratch.
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

type AutoRespawnDecision =
  | { kind: "respawn"; agent: Agent }
  | { kind: "budget_exhausted" }
  | { kind: "skip" };

/**
 * Decide whether an in_progress orphan should be auto-respawned this tick.
 *
 * Conditions for respawn:
 *  - Task has an assigned agent (required to re-drive the pipeline).
 *  - Assigned agent exists and is currently idle.
 *  - `auto_respawn_count` is below the configured max.
 *
 * If the budget is already exhausted, return "budget_exhausted" so the
 * caller can log a distinct "budget exhausted" park message. Any other
 * ineligible reason (agent missing / not idle / no agent assigned) returns
 * "skip" — the task stays parked quietly and will be re-evaluated on the
 * next tick.
 */
function evaluateAutoRespawn(
  db: DatabaseSync,
  task: { id: string; assigned_agent_id: string | null; auto_respawn_count: number },
  maxAutoRespawn: number,
): AutoRespawnDecision {
  if (task.auto_respawn_count >= maxAutoRespawn) {
    return { kind: "budget_exhausted" };
  }
  if (!task.assigned_agent_id) {
    return { kind: "skip" };
  }
  const agent = db.prepare(
    "SELECT * FROM agents WHERE id = ?",
  ).get(task.assigned_agent_id) as Agent | undefined;
  if (!agent || agent.status !== "idle") {
    return { kind: "skip" };
  }
  return { kind: "respawn", agent };
}
