import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import type { CacheService } from "../cache/cache-service.js";
import type { ReviewerRole } from "./prompt-builder.js";
import { getMaxReviewCount, hasExhaustedReviewBudget } from "../domain/review-rules.js";
import { resolveStageAgentOverride } from "./stage-agent-resolver.js";

/**
 * A single reviewer assigned to a task, together with the role they are
 * expected to play (`code` or `security`). A review panel is a list of
 * these assignments; the first entry is treated as the "primary"
 * reviewer (responsible for driving task state transitions) and any
 * remaining entries are spawned as "secondary" reviewers that run in
 * parallel and contribute verdicts without mutating task state.
 */
export interface ReviewerAssignment {
  agent: Agent;
  role: ReviewerRole;
}

/**
 * Trigger automatic code review when a task transitions to "pr_review".
 *
 * Guards:
 *  - auto_review setting must be enabled
 *  - review_count must be below the configured cap (loop prevention)
 *  - at least one idle review agent must be available
 *
 * When both a `code_reviewer` and a `security_reviewer` are idle,
 * they are spawned in parallel (see {@link findReviewAgents}). The
 * `review_count` is incremented once per trigger regardless of panel
 * size — per-role counting is deliberately avoided so the existing
 * max-iteration escalation to `human_review` still bounds total LLM
 * spend.
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

  // Assemble the review panel
  const assignments = findReviewAgents(db, currentTask.assigned_agent_id);
  if (assignments.length === 0) {
    logSystem(db, currentTask.id, "Auto review skipped: no idle review agent available");
    return;
  }

  // Increment review_count once per trigger (shared across all reviewers in
  // the panel). Per-role counting would complicate loop escalation without a
  // clear benefit — if any role keeps failing, the shared counter still
  // bounds retries and we escalate to human_review at the same cap.
  const now = Date.now();
  db.prepare("UPDATE tasks SET review_count = review_count + 1, updated_at = ? WHERE id = ?").run(now, currentTask.id);

  // Refresh task with updated review_count
  const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(currentTask.id) as Task | undefined;
  if (!freshTask) {
    return;
  }

  // Record which roles are expected for THIS review run. The stage-pipeline
  // aggregator reads this marker to decide which per-role verdicts must be
  // present before allowing the task to advance. The list is created_at-
  // scoped to the current run via the standard `created_at >= started_at`
  // filter the aggregator already applies.
  const expectedRoles = assignments.map((a) => a.role);
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
  ).run(freshTask.id, `[REVIEWER_PANEL:${expectedRoles.join(",")}]`);

  const panelDescription = assignments
    .map((a) => `${a.agent.name}(${a.role})`)
    .join(", ");
  logSystem(
    db,
    currentTask.id,
    `Auto review started: panel=[${panelDescription}]`,
  );
  ws.broadcast(
    "cli_output",
    [
      {
        task_id: currentTask.id,
        kind: "system",
        message: `[Auto Review] Starting review panel (${assignments.length} reviewer${assignments.length > 1 ? "s" : ""}): ${panelDescription}`,
      },
    ],
    { taskId: currentTask.id },
  );

  // Lazy import to break circular dependency (auto-reviewer <-> process-manager)
  const { spawnAgent, spawnSecondaryReviewer, initReviewerSession } = await import(
    "./process-manager.js"
  );

  const [primary, ...secondaries] = assignments;

  // Only create a session when there are secondaries to wait for. The
  // session's sole purpose is to defer the primary's finalization until all
  // parallel reviewers have posted their verdicts. With a single reviewer the
  // flow is identical to the legacy single-reviewer path.
  if (secondaries.length > 0) {
    initReviewerSession(freshTask.id, expectedRoles);
  }

  spawnAgent(db, ws, primary.agent, freshTask, {
    cache,
    reviewerRole: primary.role,
  });
  for (const secondary of secondaries) {
    spawnSecondaryReviewer(db, ws, secondary.agent, freshTask, secondary.role, cache);
  }
}

/**
 * Find the idle agents that should form the review panel for this task.
 *
 * Priority / panel composition:
 *  1. A `code_reviewer`-role agent (preferred primary reviewer).
 *  2. A `security_reviewer`-role agent, if one is idle and different from
 *     the code reviewer chosen above. This agent runs in parallel with the
 *     code reviewer.
 *  3. Fallback: if no `code_reviewer` role agent exists at all, fall back
 *     to any idle worker agent so the legacy single-reviewer flow keeps
 *     working. In that case the panel has a single entry with role
 *     `"code"` (the fallback agent plays the code-reviewer slot).
 *
 * The implementer (`implementerAgentId`) is always excluded so a task's
 * author cannot review their own work.
 */
export function findReviewAgents(
  db: DatabaseSync,
  implementerAgentId: string | null,
): ReviewerAssignment[] {
  const excludeId = implementerAgentId ?? "";
  const assignments: ReviewerAssignment[] = [];

  // 0. Settings override: when `review_agent_id` is configured and the
  // referenced worker is idle, use it as the primary code reviewer. The
  // role-based code_reviewer slot is skipped so we do not end up with a
  // panel of two code reviewers; the security_reviewer secondary slot
  // still applies.
  const overrideReviewer = resolveStageAgentOverride(db, "review_agent_id", [excludeId]);
  if (overrideReviewer) {
    assignments.push({ agent: overrideReviewer, role: "code" });
  }

  // 1. Primary slot: idle code_reviewer (excluding the implementer)
  const codeReviewer = assignments.some((a) => a.role === "code")
    ? undefined
    : (db
        .prepare(
          "SELECT * FROM agents WHERE role = 'code_reviewer' AND status = 'idle' AND id != ? LIMIT 1",
        )
        .get(excludeId) as Agent | undefined);
  if (codeReviewer) {
    assignments.push({ agent: codeReviewer, role: "code" });
  }

  // 2. Secondary slot: idle security_reviewer (excluding both the
  // implementer and any agent already in the panel). If none exists, the
  // panel simply stays single-agent — the task still reviews correctly
  // via the code reviewer alone.
  const usedIds = [excludeId, ...assignments.map((a) => a.agent.id)];
  const usedPlaceholders = usedIds.map(() => "?").join(",");
  const securityReviewer = db
    .prepare(
      `SELECT * FROM agents WHERE role = 'security_reviewer' AND status = 'idle' AND id NOT IN (${usedPlaceholders}) LIMIT 1`,
    )
    .get(...usedIds) as Agent | undefined;
  if (securityReviewer) {
    assignments.push({ agent: securityReviewer, role: "security" });
  }

  // 3. Fallback: no code_reviewer role agent at all → pick any idle
  // worker for the code slot so the legacy flow still works. This path
  // also runs when a deployment has seeded only generic worker agents
  // without roles.
  if (assignments.every((a) => a.role !== "code")) {
    const fallbackUsed = [excludeId, ...assignments.map((a) => a.agent.id)];
    const fallbackPlaceholders = fallbackUsed.map(() => "?").join(",");
    const anyIdle = db
      .prepare(
        `SELECT * FROM agents WHERE status = 'idle' AND agent_type = 'worker' AND id NOT IN (${fallbackPlaceholders}) LIMIT 1`,
      )
      .get(...fallbackUsed) as Agent | undefined;
    if (anyIdle) {
      // Primary must be listed first so spawnAgent drives task state.
      assignments.unshift({ agent: anyIdle, role: "code" });
    }
  }

  return assignments;
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
