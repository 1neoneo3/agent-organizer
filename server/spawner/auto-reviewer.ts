import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import type { ReviewerRole } from "./prompt-builder.js";
import { getMaxReviewCount, hasExhaustedReviewBudget } from "../domain/review-rules.js";
import { resolveStageAgentSelection } from "./stage-agent-resolver.js";

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
      "human_review",
    );
    ws.broadcast("task_update", { id: currentTask.id, status: "human_review" });
    return;
  }

  // Assemble the review panel
  const decision = resolveReviewPanel(db, currentTask.assigned_agent_id);
  if (decision.kind === "skip") {
    logSystem(db, currentTask.id, decision.reason);
    return;
  }
  const assignments = decision.assignments;
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
  // Auto-reviewer always runs during pr_review — tag the panel marker
  // explicitly so the trigger fallback cannot mis-stage it on race.
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage, agent_id) VALUES (?, 'system', ?, 'pr_review', ?)",
  ).run(freshTask.id, `[REVIEWER_PANEL:${expectedRoles.join(",")}]`, freshTask.assigned_agent_id ?? null);

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
  const { spawnAgent, spawnSecondaryReviewer, initReviewerSession, clearReviewerSession } = await import(
    "./process-manager.js"
  );
  const { handleSpawnFailure } = await import("./spawn-failures.js");

  const [primary, ...secondaries] = assignments;

  // Only create a session when there are secondaries to wait for. The
  // session's sole purpose is to defer the primary's finalization until all
  // parallel reviewers have posted their verdicts. With a single reviewer the
  // flow is identical to the legacy single-reviewer path.
  if (secondaries.length > 0) {
    initReviewerSession(freshTask.id, expectedRoles);
  }

  spawnAgent(db, ws, primary.agent, freshTask, {
    reviewerRole: primary.role,
  }).then(() => {
    for (const secondary of secondaries) {
      spawnSecondaryReviewer(db, ws, secondary.agent, freshTask, secondary.role);
    }
  }).catch((err) => {
    if (secondaries.length > 0) {
      clearReviewerSession(freshTask.id);
    }
    const handled = handleSpawnFailure(db, ws, freshTask.id, err, {
      source: "Auto reviewer",
    });
    if (handled.handled) {
      return;
    }
    console.error(`[auto-reviewer] primary spawn failed for task ${freshTask.id}:`, err);
  });
}

/**
 * Discriminated decision returned by {@link resolveReviewPanel}.
 *
 *  - `panel`: the review can run with the supplied assignments. If
 *    `assignments` is empty no idle reviewer was found at all (legacy
 *    "no idle review agent available" case); the caller logs and
 *    returns.
 *  - `skip`: the user configured `review_agent_role` / `_model` but no
 *    matching idle worker is currently reachable. The caller must NOT
 *    fall back to a default reviewer — instead it should log + return,
 *    so the next pr_review trigger (e.g. after the configured worker
 *    finishes its current task) can pick up the panel correctly.
 */
export type ReviewPanelDecision =
  | { kind: "panel"; assignments: ReviewerAssignment[] }
  | { kind: "skip"; reason: string };

/**
 * Decide the review panel for a task. Honours the
 * `review_agent_role` / `review_agent_model` override as a hard
 * constraint when configured: matching worker → use, no match → skip.
 * Without an override configured, falls back to the legacy role-based
 * selection (code_reviewer → security_reviewer secondary slot →
 * generic worker fallback).
 *
 * The implementer is always excluded so a task's author cannot review
 * their own work.
 */
export function resolveReviewPanel(
  db: DatabaseSync,
  implementerAgentId: string | null,
): ReviewPanelDecision {
  const excludeId = implementerAgentId ?? "";
  const assignments: ReviewerAssignment[] = [];

  // 0. Settings override: stage-specific role/model is a hard
  // constraint. If configured, only a matching worker is acceptable
  // for the primary code slot — skipping is preferable to silently
  // running review with the wrong agent.
  const overrideResult = resolveStageAgentSelection(
    db,
    "review_agent_role",
    "review_agent_model",
    { excludeIds: [excludeId] },
  );

  if (overrideResult.status === "configured_no_match") {
    return {
      kind: "skip",
      reason:
        "Auto review skipped: review_agent_role/model is configured but no matching idle worker exists; will retry on the next pr_review trigger",
    };
  }
  if (overrideResult.status === "configured_no_match_in_pool") {
    // resolveReviewPanel does not pass a candidatePool, so this branch
    // is unreachable from here. We still handle it explicitly so the
    // exhaustiveness check for TypeScript narrows correctly and any
    // future caller that does pass a pool gets sane behaviour.
    return {
      kind: "skip",
      reason:
        "Auto review skipped: review_agent_role/model match was already taken in this tick; will retry on the next pr_review trigger",
    };
  }
  if (overrideResult.status === "configured_match") {
    assignments.push({ agent: overrideResult.agent, role: "code" });
  }

  // 1. Primary slot: idle code_reviewer (excluding the implementer).
  // Only consulted when the override is unconfigured — when configured
  // we either have an override match (filled above) or have already
  // returned `skip`.
  if (overrideResult.status === "unconfigured") {
    const codeReviewer = db
      .prepare(
        "SELECT * FROM agents WHERE role = 'code_reviewer' AND status = 'idle' AND id != ? LIMIT 1",
      )
      .get(excludeId) as Agent | undefined;
    if (codeReviewer) {
      assignments.push({ agent: codeReviewer, role: "code" });
    }
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
  // without roles. Only relevant for the unconfigured override path.
  if (
    overrideResult.status === "unconfigured"
    && assignments.every((a) => a.role !== "code")
  ) {
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

  return { kind: "panel", assignments };
}

/**
 * Backward-compatible wrapper that returns the assignments list only.
 * `skip` decisions are flattened to an empty array — callers that need
 * to distinguish "configured but no match" from "no idle reviewer at
 * all" must use {@link resolveReviewPanel} instead.
 *
 * Kept so existing tests / call sites continue to work; new code should
 * prefer the structured decision API.
 */
export function findReviewAgents(
  db: DatabaseSync,
  implementerAgentId: string | null,
): ReviewerAssignment[] {
  const decision = resolveReviewPanel(db, implementerAgentId);
  return decision.kind === "panel" ? decision.assignments : [];
}

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function logSystem(
  db: DatabaseSync,
  taskId: string,
  message: string,
  stage: "pr_review" | "human_review" = "pr_review",
): void {
  // Auto-reviewer always runs for pr_review stage. Tag explicitly so the
  // trigger fallback cannot mis-stage if this INSERT races with a task
  // status UPDATE in performFinalization. Escalation messages are tagged
  // as human_review because they are emitted after the task has already
  // crossed that transition.
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage) VALUES (?, 'system', ?, ?)"
  ).run(taskId, message, stage);
}
