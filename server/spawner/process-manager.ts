import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { buildAgentArgs, normalizeStreamChunk, withCliPathFallback, REVIEW_ALLOWED_TOOLS } from "./cli-tools.js";
import { runExplorePhase } from "./explore-phase.js";
import { parseStreamLineFromObj, type SubtaskEvent } from "./output-parser.js";
import { classifyEvent, isIgnoredEvent, parseInteractivePrompt, detectTextInteractivePrompt, type InteractivePromptData } from "./event-classifier.js";
import {
  buildTaskPrompt,
  buildReviewPrompt,
  buildQaPrompt,
  buildTestGenerationPrompt,
  buildCiCheckPrompt,
  buildRefinementPrompt,
  type ReviewerRole,
} from "./prompt-builder.js";
import { triggerAutoReview } from "./auto-reviewer.js";
import { triggerAutoQa } from "./auto-qa.js";
import { triggerAutoTestGen } from "./auto-test-gen.js";
import {
  isParallelImplTestEnabled,
  recordParallelTestCompletion,
} from "../workflow/parallel-impl.js";
import { triggerAutoCiCheck } from "./auto-ci-check.js";
import { triggerAutoChecks, waitForActiveChecks } from "./auto-checks.js";
import { loadProjectWorkflow, type ProjectWorkflow } from "../workflow/loader.js";
import { resolveAgentRuntimePolicy } from "../workflow/runtime-policy.js";
import { determineNextStage, resolveActiveStages } from "../workflow/stage-pipeline.js";
import { notifyTaskStatus } from "../notify/telegram.js";
import type { TaskLogKind } from "../types/runtime.js";
import {
  TASK_RUN_IDLE_TIMEOUT_MS,
  TASK_RUN_HARD_TIMEOUT_MS,
} from "../config/runtime.js";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import { recordDbLogInsertMs, recordStdoutChunkMs } from "../perf/metrics.js";
import { getHeartbeatManager } from "./heartbeat-manager.js";
import type { CacheService } from "../cache/cache-service.js";
import { prepareTaskWorkspace } from "../workflow/workspace-manager.js";
import { promoteTaskReviewArtifact, type ReviewArtifactPromotionResult } from "../workflow/review-artifact.js";
import { runWorkflowHooks } from "../workflow/hooks.js";

const activeProcesses = new Map<string, ChildProcess>();
const pendingFeedback = new Map<string, { message: string; previousStatus: string }>();
const capturedSessionIds = new Map<string, string>(); // taskId -> claude session_id
const pendingInteractivePrompts = new Map<string, { data: InteractivePromptData; createdAt: number }>();
const timeoutReasons = new Map<string, "idle_timeout" | "hard_timeout">(); // taskId -> timeout reason

/**
 * Coordination state for a parallel review panel. When `triggerAutoReview`
 * spawns more than one reviewer for the same task, it records the session
 * here BEFORE the primary reviewer's `spawnAgent` close handler can fire.
 *
 * Responsibilities:
 *  - Track secondary (non-primary) reviewer child processes so the
 *    primary's close handler can detect that verdict collection isn't
 *    finished yet and defer finalization.
 *  - Hold the deferred-finalization closure that the LAST-to-finish
 *    secondary must invoke (otherwise the task would stall in pr_review).
 *  - Provide a single place for `killAgent` to terminate every reviewer
 *    in the panel when the task is cancelled.
 *
 * Single-reviewer runs DO NOT create a session: the legacy behavior of
 * finalizing immediately on primary close is preserved.
 */
interface ReviewerSession {
  taskId: string;
  expectedRoles: ReviewerRole[];
  /** agentId → ChildProcess for every non-primary reviewer currently running */
  secondaries: Map<string, ChildProcess>;
  /** Set once the primary reviewer's close handler has fired. */
  primaryDone: boolean;
  /**
   * Closure captured from the primary's close handler. When the primary
   * finishes while secondaries are still running, it stores its
   * finalization work here and returns without updating task state. The
   * LAST-to-finish secondary is responsible for calling this closure so
   * the task can advance.
   */
  primaryFinalize: (() => void) | null;
}

const reviewerSessions = new Map<string, ReviewerSession>();

const MAX_CONTEXT_RESETS = 3;

/**
 * Create a reviewer-panel coordination session for a task. Must be
 * called BEFORE the primary reviewer's `spawnAgent` invocation so that
 * the primary's close handler sees the session during finalization.
 *
 * Only called by auto-reviewer when the panel has more than one entry.
 */
export function initReviewerSession(
  taskId: string,
  expectedRoles: ReviewerRole[],
): void {
  reviewerSessions.set(taskId, {
    taskId,
    expectedRoles,
    secondaries: new Map(),
    primaryDone: false,
    primaryFinalize: null,
  });
}

/** Test-only helper: inspect the current session for a task, or undefined. */
export function getReviewerSession(taskId: string): ReviewerSession | undefined {
  return reviewerSessions.get(taskId);
}

/** Restore pending interactive prompts from DB on server startup */
export function restorePendingInteractivePrompts(db: DatabaseSync): void {
  const rows = db.prepare(
    "SELECT id, interactive_prompt_data FROM tasks WHERE interactive_prompt_data IS NOT NULL AND status = 'in_progress'"
  ).all() as Array<{ id: string; interactive_prompt_data: string }>;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.interactive_prompt_data) as { data: InteractivePromptData; createdAt: number };
      pendingInteractivePrompts.set(row.id, parsed);
    } catch { /* ignore corrupted data */ }
  }
}

function persistPromptToDb(db: DatabaseSync, taskId: string, entry: { data: InteractivePromptData; createdAt: number } | null): void {
  try {
    db.prepare("UPDATE tasks SET interactive_prompt_data = ? WHERE id = ?")
      .run(entry ? JSON.stringify(entry) : null, taskId);
  } catch { /* best-effort persist */ }
}

export function getPendingInteractivePrompt(taskId: string): { data: InteractivePromptData; createdAt: number } | undefined {
  return pendingInteractivePrompts.get(taskId);
}

export function getAllPendingInteractivePrompts(): Map<string, { data: InteractivePromptData; createdAt: number }> {
  return pendingInteractivePrompts;
}

export function clearPendingInteractivePrompt(taskId: string, db?: DatabaseSync): boolean {
  const deleted = pendingInteractivePrompts.delete(taskId);
  if (deleted && db) {
    persistPromptToDb(db, taskId, null);
  }
  return deleted;
}

export function getActiveProcesses(): Map<string, ChildProcess> {
  return activeProcesses;
}

export function getCapturedSessionId(taskId: string): string | undefined {
  return capturedSessionIds.get(taskId);
}

/** Queue feedback for a running task: kills the process and respawns with --resume */
export function queueFeedbackAndRestart(taskId: string, message: string, previousStatus: string): boolean {
  const child = activeProcesses.get(taskId);
  if (!child) return false;

  pendingFeedback.set(taskId, { message, previousStatus });

  try {
    child.kill("SIGTERM");
  } catch {
    // already dead
  }

  return true;
}

function invalidateCaches(cache?: CacheService): void {
  if (!cache) return;
  cache.invalidatePattern("tasks:*");
  cache.del("agents:all");
}

/**
 * Extract executed shell commands from task logs for PR verification section.
 * Parses Codex/Claude CLI stdout JSON to find command_execution items.
 * Returns up to 10 unique commands with short descriptions.
 */
function extractExecutedCommands(
  db: DatabaseSync,
  taskId: string,
  runStartedAt: number,
): string[] {
  const logs = db
    .prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'stdout' AND created_at >= ? ORDER BY id ASC",
    )
    .all(taskId, runStartedAt) as Array<{ message: string }>;

  const commands = new Set<string>();
  for (const log of logs) {
    // Parse Codex stdout JSON: {"type":"item.completed","item":{"type":"command_execution","command":"/bin/bash -lc 'xxx'",...}}
    const match = log.message.match(/"type":"item\.completed"[^}]*"type":"command_execution"[^}]*"command":"([^"]+)"/);
    if (!match) continue;
    let cmd = match[1]
      .replace(/\\n/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    // Strip /bin/bash -lc wrapper
    const bashMatch = cmd.match(/^\/bin\/bash -lc\s+['"](.+)['"]\s*$/);
    if (bashMatch) cmd = bashMatch[1];
    // Skip noise: read-only inspections, internal tool calls
    if (/^(cat|ls|sed|head|tail|rg|grep|find|wc|git (status|log|diff|show|rev-parse|symbolic-ref|branch|remote)|date|pwd|which)\b/.test(cmd)) continue;
    if (cmd.length > 120) cmd = cmd.slice(0, 117) + "...";
    commands.add(cmd);
    if (commands.size >= 10) break;
  }
  return Array.from(commands);
}

/**
 * Scan task_logs for GitHub URLs the agent produced during its run.
 *
 * Two sources the task might have touched are considered:
 *   - A GitHub pull-request URL: `https://github.com/<owner>/<repo>/pull/<n>`
 *   - A GitHub repository URL:  `https://github.com/<owner>/<repo>`
 *
 * This is used as a fallback when `promoteTaskReviewArtifact` cannot
 * run (e.g. the project is `workspaceMode: shared`, or the agent
 * created a brand-new nested repository inside project_path). Those
 * code paths never populate `pr_url` / `repository_url`, so the UI
 * showed neither even when the agent had already pushed a public PR.
 *
 * ----------------------------------------------------------------------
 * Two-stage extraction strategy
 * ----------------------------------------------------------------------
 *
 * Stage 1 (high-trust command-linked candidates):
 *   Walk task_logs in order. When a `tool_call` row contains
 *   `gh pr create` or `gh repo create`, the IMMEDIATELY-FOLLOWING
 *   `tool_result` / `stdout` row (within a short window) is treated as
 *   that command's output. URLs extracted from that row are recorded as
 *   high-trust results and short-circuit Stage 2. This is the cleanest
 *   signal: it's the agent's own created URL, not a reference.
 *
 * Stage 2 (noise-filtered conservative fallback):
 *   When Stage 1 finds nothing, fall back to a scan of all relevant log
 *   rows, but split by real newlines and reject "transcript noise":
 *     - lines longer than 500 chars (likely serialised JSON blobs)
 *     - lines containing `\"` or `\\` or `\n` as literal 2-char
 *       sequences (doubly-stringified agent session transcripts from
 *       Codex / Claude Code verbose logs)
 *   `tool_call` rows are excluded entirely because agents sometimes
 *   pass URLs into commands they're *reading* (for example
 *   `gh pr view <url>`), which would be mistaken for a creation.
 *
 * Both stages share the same underlying URL regex and ignore well-known
 * non-repo paths under `github.com` (orgs, search, notifications, etc.).
 *
 * When `options.runStartedAt` is supplied, only logs with
 * `created_at >= runStartedAt` are considered so prior runs cannot
 * contaminate the current run's detection.
 *
 * Historical note: before the two-stage rewrite, this function picked
 * the "most frequently mentioned" URL across all log rows. That logic
 * false-matched on tasks where the agent's verbose CLI session logs
 * (containing references to unrelated sibling directories or prior
 * work) landed in stdout as large JSON blobs — the URLs mentioned in
 * those transcripts dominated the frequency count and were mistakenly
 * recorded as the task's own produced artifact.
 */

const GITHUB_PR_PATTERN = /https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/pull\/(\d+)/g;
const GITHUB_REPO_PATTERN = /https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=[^A-Za-z0-9._/-]|$)/g;

const GH_PR_CREATE_CMD = /gh\s+pr\s+create\b/;
const GH_REPO_CREATE_CMD = /gh\s+repo\s+create\b/;

const NON_REPO_OWNERS = new Set([
  "orgs",
  "search",
  "notifications",
  "settings",
  "about",
  "pricing",
  "features",
  "marketplace",
]);

/**
 * A line is considered transcript noise when it looks like a serialised
 * fragment of a verbose CLI session log rather than fresh command
 * output. Real command output lines have plain quotes and real newlines;
 * only doubly-stringified transcripts end up with `\"` or `\n` as raw
 * 2-char sequences inside a single log row.
 */
function looksLikeTranscriptNoise(line: string): boolean {
  if (line.length > 500) return true;
  // `\"` (backslash followed by quote) — escaped JSON quote in a
  // re-stringified payload. Real JSON that is NOT a nested string has
  // plain `"` characters and does not match this check.
  if (line.includes('\\"')) return true;
  // `\\` (two backslashes) — escaped backslash in a re-stringified
  // payload.
  if (line.includes("\\\\")) return true;
  // `\n` as a literal 2-char sequence (NOT a real LF). Real newlines are
  // already split off by the caller; only doubly-escaped transcripts
  // still contain this.
  if (line.includes("\\n")) return true;
  return false;
}

function derivePrRepoUrl(prUrl: string): string | null {
  const match = prUrl.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)/);
  return match?.[1] ?? null;
}

function collectUrlsFromText(text: string): { prUrls: string[]; repoUrls: string[] } {
  const prUrls: string[] = [];
  const repoUrls: string[] = [];

  for (const match of text.matchAll(GITHUB_PR_PATTERN)) {
    const owner = match[1];
    if (NON_REPO_OWNERS.has(owner)) continue;
    const repo = match[2];
    prUrls.push(`https://github.com/${owner}/${repo}/pull/${match[3]}`);
  }

  for (const match of text.matchAll(GITHUB_REPO_PATTERN)) {
    const owner = match[1];
    if (NON_REPO_OWNERS.has(owner)) continue;
    const repo = match[2].replace(/\.git$/, "");
    repoUrls.push(`https://github.com/${owner}/${repo}`);
  }

  return { prUrls, repoUrls };
}

export function extractGithubArtifactsFromLogs(
  db: DatabaseSync,
  taskId: string,
  options: { runStartedAt?: number | null } = {},
): { prUrl: string | null; repositoryUrl: string | null } {
  const runStartedAt = options.runStartedAt ?? null;

  const rows = (runStartedAt !== null
    ? db
        .prepare(
          "SELECT kind, message FROM task_logs WHERE task_id = ? AND created_at >= ? ORDER BY id ASC",
        )
        .all(taskId, runStartedAt)
    : db
        .prepare(
          "SELECT kind, message FROM task_logs WHERE task_id = ? ORDER BY id ASC",
        )
        .all(taskId)) as Array<{ kind: string; message: string }>;

  // ---- Stage 1: command-linked high-trust extraction ----
  // Walk logs sequentially. When a recognised `gh` creation command is
  // seen as a tool_call, consume the next tool_result/stdout within a
  // small window (to tolerate interleaved thinking events) and record
  // any URL from it as the authoritative answer.
  const COMMAND_WINDOW_ROWS = 8;
  type Pending = { cmd: "pr_create" | "repo_create"; rowsRemaining: number };
  let pending: Pending | null = null;
  let highTrustPrUrl: string | null = null;
  let highTrustRepoUrl: string | null = null;

  for (const row of rows) {
    if (highTrustPrUrl && highTrustRepoUrl) break;

    if (row.kind === "tool_call") {
      // A fresh recognised command replaces any still-pending one —
      // if the previous command never produced output we give up on it.
      if (GH_PR_CREATE_CMD.test(row.message)) {
        pending = { cmd: "pr_create", rowsRemaining: COMMAND_WINDOW_ROWS };
      } else if (GH_REPO_CREATE_CMD.test(row.message)) {
        pending = { cmd: "repo_create", rowsRemaining: COMMAND_WINDOW_ROWS };
      }
      continue;
    }

    if (pending !== null && (row.kind === "tool_result" || row.kind === "stdout")) {
      const { prUrls, repoUrls } = collectUrlsFromText(row.message);
      if (pending.cmd === "pr_create" && prUrls.length > 0) {
        if (!highTrustPrUrl) highTrustPrUrl = prUrls[0];
        pending = null;
        continue;
      }
      if (pending.cmd === "repo_create") {
        // `gh repo create` typically prints the new repo URL; accept
        // either the bare repo URL or a PR URL derived from it.
        if (repoUrls.length > 0) {
          if (!highTrustRepoUrl) highTrustRepoUrl = repoUrls[0];
          pending = null;
          continue;
        }
        if (prUrls.length > 0) {
          const derived = derivePrRepoUrl(prUrls[0]);
          if (derived && !highTrustRepoUrl) highTrustRepoUrl = derived;
          pending = null;
          continue;
        }
      }
      pending.rowsRemaining -= 1;
      if (pending.rowsRemaining <= 0) pending = null;
    }
  }

  if (highTrustPrUrl) {
    return {
      prUrl: highTrustPrUrl,
      repositoryUrl: derivePrRepoUrl(highTrustPrUrl) ?? highTrustRepoUrl,
    };
  }
  if (highTrustRepoUrl) {
    return { prUrl: null, repositoryUrl: highTrustRepoUrl };
  }

  // ---- Stage 2: noise-filtered frequency scan ----
  // Fallback when no recognised creation command was seen. This path
  // exists for legacy / off-stream signals (assistant summary text,
  // raw gh stdout that wasn't captured via tool_call). Noise filtering
  // keeps verbose session-log transcripts from dominating the count.
  const prCounts = new Map<string, number>();
  const repoCounts = new Map<string, number>();

  for (const row of rows) {
    // Skip tool_call rows — they contain URLs the agent is passing IN
    // (e.g. `gh pr view <url>`), which are references, not creations.
    if (row.kind === "tool_call") continue;
    // Skip process-lifecycle messages.
    if (row.kind === "system") continue;

    for (const line of row.message.split(/\r?\n/)) {
      if (looksLikeTranscriptNoise(line)) continue;
      const { prUrls, repoUrls } = collectUrlsFromText(line);
      for (const url of prUrls) prCounts.set(url, (prCounts.get(url) ?? 0) + 1);
      for (const url of repoUrls) repoCounts.set(url, (repoCounts.get(url) ?? 0) + 1);
    }
  }

  const pickMostFrequent = (counts: Map<string, number>): string | null => {
    let best: string | null = null;
    let bestCount = 0;
    for (const [url, count] of counts) {
      if (count > bestCount) {
        best = url;
        bestCount = count;
      }
    }
    return best;
  };

  const prUrl = pickMostFrequent(prCounts);
  let repositoryUrl: string | null = null;
  if (prUrl) {
    repositoryUrl = derivePrRepoUrl(prUrl);
  }
  if (!repositoryUrl) {
    repositoryUrl = pickMostFrequent(repoCounts);
  }

  return { prUrl, repositoryUrl };
}

export function isReviewRunTask(
  task: Pick<Task, "status">,
  previousStatus?: Task["status"] | string,
): boolean {
  return task.status === "pr_review" || previousStatus === "pr_review";
}

export function spawnAgent(
  db: DatabaseSync,
  ws: WsHub,
  agent: Agent,
  task: Task,
  options?: {
    continuePrompt?: string;
    previousStatus?: string;
    cache?: CacheService;
    finalizeOnComplete?: boolean;
    /**
     * Role hint for review runs. When set, the primary reviewer will
     * emit a role-tagged verdict (`[REVIEW:<role>:PASS]`) and the close
     * handler will consult `reviewerSessions` for deferred-finalization
     * coordination with any secondary reviewers.
     */
    reviewerRole?: ReviewerRole;
    /**
     * AO Phase 3: when true, this spawn is the *parallel tester* half of
     * the parallel implementer + tester pair. The parallel tester shares
     * a worktree with the implementer, runs `buildTestGenerationPrompt`
     * in parallel mode, and finalizes by writing a
     * `[PARALLEL_TEST:DONE]` marker instead of driving the task status —
     * the implementer remains the source of truth for status transitions.
     */
    parallelTester?: boolean;
  }
): { pid: number } {
  const cache = options?.cache;
  const isContinue = !!options?.continuePrompt;
  const isParallelTester = options?.parallelTester === true;
  const finalizeOnComplete = options?.finalizeOnComplete ?? false;
  const resumeSessionId = isContinue ? capturedSessionIds.get(task.id) : undefined;
  const projectPath = task.project_path ?? process.cwd();
  const workflow = loadProjectWorkflow(projectPath);
  const runtimePolicy = resolveAgentRuntimePolicy(agent, workflow);
  // Determine if self-review applies (skip for continue mode)
  const selfReviewThreshold = getSetting(db, "self_review_threshold") ?? "small";
  const selfReview = !isContinue && (
    selfReviewThreshold === "all" ||
    (selfReviewThreshold === "medium" && (task.task_size === "small" || task.task_size === "medium")) ||
    (selfReviewThreshold === "small" && task.task_size === "small")
  );

  const isReviewRun = isReviewRunTask(task, options?.previousStatus);

  const isQaRun = task.status === "qa_testing";
  // A parallel tester spawn runs the test_generation prompt even though
  // the task's status stays in_progress, so treat it as a test-gen run
  // for tool-restrictions, handoff context, and prompt routing.
  const isTestGenRun = task.status === "test_generation" || isParallelTester;
  const isCiCheckRun = task.status === "ci_check";
  // Refinement: task is already in refinement status, or dispatching from
  // inbox when refinement is the first active stage in the pipeline.
  const activeStages = resolveActiveStages(db, workflow, task.task_size);
  const isRefinementRun = task.status === "refinement" || (task.status === "inbox" && activeStages[0] === "refinement");
  const parallelImplEnabled =
    !isParallelTester && !isContinue && isParallelImplTestEnabled(db);

  // Restrict tools for review/QA/ci-check phases (read-only)
  const allowedTools = (isReviewRun || isQaRun || isCiCheckRun || isRefinementRun)
    ? REVIEW_ALLOWED_TOOLS
    : undefined;

  const args = buildAgentArgs(agent.cli_provider, {
    model: agent.cli_model ?? undefined,
    reasoningLevel: agent.cli_reasoning_level ?? undefined,
    resumeSessionId,
    codexSandboxMode: runtimePolicy.codexSandboxMode ?? undefined,
    codexApprovalPolicy: runtimePolicy.codexApprovalPolicy ?? undefined,
    allowedTools,
  });

  // Extract handoff context for QA/review agents
  let handoffContext = "";
  if ((isQaRun || isReviewRun || isTestGenRun || isCiCheckRun || isRefinementRun) && !isContinue) {
    const handoffs = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '[HANDOFF]%' ORDER BY created_at DESC LIMIT 3"
    ).all(task.id) as Array<{ message: string }>;
    if (handoffs.length > 0) {
      handoffContext = "\n\n## Previous Phase Context\n" + handoffs.map(h => h.message.replace("[HANDOFF] ", "")).join("\n");
    }
  }

  // Run Explore phase before Implement (if enabled and applicable)
  let exploreContext = "";
  if (!isContinue && !isQaRun && !isReviewRun && !isTestGenRun && !isCiCheckRun && !isRefinementRun) {
    // Check for existing explore result (from previous run)
    const existingExplore = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '[EXPLORE]%' ORDER BY created_at DESC LIMIT 1"
    ).get(task.id) as { message: string } | undefined;

    if (existingExplore) {
      exploreContext = "\n\n## Explore Phase Result (read-only investigation)\n" +
        existingExplore.message.replace("[EXPLORE] ", "");
    } else {
      const exploreResult = runExplorePhase(db, ws, agent, task);
      if (exploreResult) {
        exploreContext = "\n\n## Explore Phase Result (read-only investigation)\n" + exploreResult;
      }
    }
  }

  const prompt = isContinue
    ? options!.continuePrompt!
    : (isRefinementRun
      ? buildRefinementPrompt(task)
      : (isTestGenRun
        ? buildTestGenerationPrompt(task, workflow?.projectType ?? "generic", {
            parallel: isParallelTester,
          }) + handoffContext
        : (isQaRun
          ? buildQaPrompt(task, workflow?.projectType ?? "generic") + handoffContext
          : (isCiCheckRun
            ? buildCiCheckPrompt(task) + handoffContext
            : (isReviewRun
              ? buildReviewPrompt(task, { reviewerRole: options?.reviewerRole ?? "code" }) + handoffContext
              : buildTaskPrompt(task, {
                  selfReview,
                  workflow,
                  runtimePolicy,
                  parallelScope: parallelImplEnabled ? "implementer" : undefined,
                }) + exploreContext)))));

  // Log directory
  const logDir = join("data", "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${task.id}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  // Clean env
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE;
  cleanEnv.PATH = withCliPathFallback(String(cleanEnv.PATH ?? ""));
  cleanEnv.NO_COLOR = "1";
  cleanEnv.FORCE_COLOR = "0";
  cleanEnv.CI = "1";
  if (!cleanEnv.TERM) cleanEnv.TERM = "dumb";

  const workspace = prepareTaskWorkspace(task, workflow);

  // Run before_run hooks (env setup, dependency install, etc.)
  if (workflow?.beforeRun.length && !isContinue) {
    const beforeResults = runWorkflowHooks(workflow.beforeRun, workspace.cwd);
    const logBefore = db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)");
    for (const hr of beforeResults) {
      logBefore.run(task.id, `[before_run] ${hr.command}: ${hr.ok ? "OK" : "FAILED"}${hr.output ? `\n${hr.output.slice(0, 500)}` : ""}`);
    }
  }

  const child = spawn(args[0], args.slice(1), {
    cwd: workspace.cwd,
    env: cleanEnv,
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let terminatedBySpawnError = false;

  activeProcesses.set(task.id, child);

  // Update task and agent status (skip for continue — already in_progress)
  if (!isContinue) {
    const now = Date.now();
    // Preserve current status for QA/review/test_generation/ci_check runs — only set in_progress for inbox tasks
    const currentStatus = task.status;
    const shouldTransitionFromInbox = currentStatus === "inbox";
    if (isParallelTester) {
      // The implementer "owns" assigned_agent_id / started_at / status.
      // The parallel tester must not overwrite them — it just borrows the
      // same worktree and logs a [PARALLEL_TEST:DONE] marker on exit.
      // Only flip the *tester* agent to working so the UI shows both
      // agents busy during parallel execution.
    } else if (shouldTransitionFromInbox) {
      // When refinement is the first active stage, transition to refinement
      // instead of in_progress so the pipeline gate is respected.
      const firstStage = isRefinementRun ? "refinement" : "in_progress";
      db.prepare("UPDATE tasks SET status = ?, assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?").run(firstStage, agent.id, now, now, task.id);
    } else {
      db.prepare("UPDATE tasks SET assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?").run(agent.id, now, now, task.id);
    }
    db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?").run(task.id, now, agent.id);

    invalidateCaches(cache);
    const startedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task | undefined;
    ws.broadcast("task_update", startedTask ?? { id: task.id, status: shouldTransitionFromInbox ? (isRefinementRun ? "refinement" : "in_progress") : currentStatus, started_at: now });
    ws.broadcast("agent_status", { id: agent.id, status: "working", current_task_id: task.id });

    // AO Phase 3: if parallel impl/test mode is enabled and this is an
    // implementer spawn (not the parallel tester itself, not a review /
    // QA / test-gen / ci-check run, not a feedback continue), fire a
    // parallel tester now so it runs concurrently. `triggerParallelTester`
    // is idempotent and no-ops if the setting is off, no idle tester
    // exists, or a DONE marker is already present.
    if (
      parallelImplEnabled &&
      !isReviewRun &&
      !isQaRun &&
      !isTestGenRun &&
      !isCiCheckRun &&
      !isRefinementRun
    ) {
      const freshTask = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(task.id) as unknown as Task;
      setTimeout(async () => {
        try {
          const { triggerParallelTester } = await import(
            "../workflow/parallel-impl.js"
          );
          await triggerParallelTester(db, ws, freshTask, { cache });
        } catch (err) {
          db.prepare(
            "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
          ).run(
            task.id,
            `Parallel tester trigger failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }, 500);
    }
  }

  // Send prompt via stdin
  if (child.stdin) {
    child.stdin.write(prompt);
    child.stdin.end();
  }

  // Dedup: track recent assistant messages to skip duplicates from multiple event formats
  const recentAssistantMessages = new Set<string>();

  // Loop detection: track normalized stderr patterns
  const LOOP_THRESHOLD = 3;
  const stderrPatternCounts = new Map<string, number>();
  let loopDetected = false;

  function normalizeStderrForLoop(text: string): string {
    return text
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*/g, "TIMESTAMP")
      .replace(/line \d+/gi, "line N")
      .replace(/:\d+:\d+/g, ":N:N")
      .replace(/0x[0-9a-fA-F]+/g, "0xADDR")
      .trim();
  }

  // Flag to stop processing stdout after an interactive prompt is detected and process killed
  let interactivePromptKilled = false;

  // Subtask tracking
  const subtaskMap = new Map<string, string>(); // toolUseId -> subtaskId

  // Pre-compile prepared statements (avoid re-compiling in hot data handler)
  const insertLogStmt = db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, ?, ?)"
  );
  const insertStderrStmt = db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'stderr', ?)"
  );

  if (!isContinue) {
    const runtimeMessage = `[Runtime] ${runtimePolicy.summary}`;
    insertLogStmt.run(task.id, "system", runtimeMessage);
    ws.broadcast(
      "cli_output",
      [{ task_id: task.id, kind: "system", message: runtimeMessage }],
      { taskId: task.id },
    );
  }

  function insertLogBatch(entries: Array<{ kind: TaskLogKind; message: string }>): void {
    if (entries.length === 0) {
      return;
    }

    const t0 = performance.now();
    db.exec("BEGIN");
    try {
      for (const entry of entries) {
        insertLogStmt.run(task.id, entry.kind, entry.message);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    recordDbLogInsertMs(performance.now() - t0);
  }

  // Timeout management
  let idleTimer = resetIdleTimer();
  const hardTimer = setTimeout(() => {
    killAgent(task.id, "hard_timeout");
  }, TASK_RUN_HARD_TIMEOUT_MS);

  function resetIdleTimer(): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      killAgent(task.id, "idle_timeout");
    }, TASK_RUN_IDLE_TIMEOUT_MS);
  }

  // Heartbeat: register with the shared scheduler instead of starting a
  // per-process setInterval. The scheduler consolidates all active tasks
  // into a single periodic UPDATE wrapped in one transaction, so the
  // writer lock is acquired once per tick regardless of how many agents
  // are running in parallel. registerTask also stamps `last_heartbeat_at`
  // immediately, covering the gap between spawn and the first scheduled
  // tick. In tests the singleton is sometimes not initialized; we treat
  // that as a no-op.
  getHeartbeatManager()?.registerTask(task.id);

  // stdout handler
  child.stdout?.on("data", (data: Buffer) => {
    const chunkStart = performance.now();

    // Skip processing if we already killed the process for an interactive prompt
    if (interactivePromptKilled) return;

    clearTimeout(idleTimer);
    idleTimer = resetIdleTimer();

    const text = normalizeStreamChunk(data);
    if (!text.trim()) return;

    // Log raw text to file
    logStream.write(text);

    // Classify each line and collect entries
    const classified: Array<{ kind: TaskLogKind; message: string }> = [];

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Try to parse as JSON and classify
      let obj: Record<string, unknown> | null = null;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        // Not JSON — treat as plain stdout
      }

      if (obj) {
        // Capture session_id for resume on feedback
        if (!capturedSessionIds.has(task.id) && typeof obj.session_id === "string") {
          capturedSessionIds.set(task.id, obj.session_id);
        }

        const event = classifyEvent(agent.cli_provider, obj);
        if (isIgnoredEvent(event)) {
          // Known structured control event (e.g., thread.started, turn.started,
          // or recognized item.* with no displayable content). Drop silently
          // instead of falling back to stdout, which would otherwise dump
          // multi-KB JSON blobs (including huge `aggregated_output` fields
          // from shell command_execution events) into the terminal view.
        } else if (event) {
          classified.push({ kind: event.kind, message: event.message });
        } else {
          // Unrecognized JSON event — fall back to stdout, but truncate to
          // avoid dumping huge payloads if an unknown event carries a large
          // output field.
          const MAX_RAW_JSON_STDOUT = 4000;
          const safe =
            trimmed.length > MAX_RAW_JSON_STDOUT
              ? `${trimmed.slice(0, MAX_RAW_JSON_STDOUT)}... [truncated ${trimmed.length - MAX_RAW_JSON_STDOUT} bytes]`
              : trimmed;
          classified.push({ kind: "stdout", message: safe });
        }

        // Detect interactive prompts (ExitPlanMode / AskUserQuestion)
        // Kill the process immediately to prevent CLI from auto-resolving the prompt.
        // The user will respond via the UI, then the agent is respawned with --resume.
        const interactivePrompt = parseInteractivePrompt(obj);
        if (interactivePrompt && !pendingInteractivePrompts.has(task.id)) {
          const entry = { data: interactivePrompt, createdAt: Date.now() };
          pendingInteractivePrompts.set(task.id, entry);
          persistPromptToDb(db, task.id, entry);
          ws.broadcast("interactive_prompt", { task_id: task.id, ...interactivePrompt });
          insertLogStmt.run(task.id, "system", `Interactive prompt detected: ${interactivePrompt.promptType} (tool_use_id: ${interactivePrompt.toolUseId}). Killing process to await user response.`);

          // Kill the process so it can't auto-resolve the prompt
          interactivePromptKilled = true;
          try { child.kill("SIGTERM"); } catch { /* already dead */ }
          break; // Stop processing remaining lines in this chunk
        }

        // Text-based interactive prompt detection (for Codex/Gemini/any provider)
        // Only check "assistant" kind events — agent's direct text output
        if (event && event.kind === "assistant" && !pendingInteractivePrompts.has(task.id)) {
          const textPrompt = detectTextInteractivePrompt(event.message);
          if (textPrompt) {
            const entry = { data: textPrompt, createdAt: Date.now() };
            pendingInteractivePrompts.set(task.id, entry);
            persistPromptToDb(db, task.id, entry);
            ws.broadcast("interactive_prompt", { task_id: task.id, ...textPrompt });
            insertLogStmt.run(task.id, "system", `Text-based interactive prompt detected. Killing process to await user response.`);

            interactivePromptKilled = true;
            try { child.kill("SIGTERM"); } catch { /* already dead */ }
            break;
          }
        }

        // Subtask parsing (reuse pre-parsed object)
        const subtaskEvent = parseStreamLineFromObj(agent.cli_provider, obj);
        if (subtaskEvent) handleSubtaskEvent(db, ws, task.id, subtaskEvent, subtaskMap);
      } else {
        classified.push({ kind: "stdout", message: trimmed });
      }
    }

    // Deduplicate assistant messages (CLI emits same text in multiple event formats)
    const deduped = classified.filter((entry) => {
      if (entry.kind !== "assistant") return true;
      const key = entry.message.slice(0, 500);
      if (recentAssistantMessages.has(key)) return false;
      recentAssistantMessages.add(key);
      // Keep set bounded
      if (recentAssistantMessages.size > 50) {
        const first = recentAssistantMessages.values().next().value!;
        recentAssistantMessages.delete(first);
      }
      return true;
    });

    // Persist all entries
    if (deduped.length > 0) {
      insertLogBatch(deduped);
    }

    // Broadcast as array (consistent shape for clients)
    if (deduped.length > 0) {
      ws.broadcast("cli_output", deduped.map((e) => ({ task_id: task.id, ...e })), { taskId: task.id });
    }

    // Check for self-review result
    if (selfReview && text.includes("[SELF_REVIEW:PASS]")) {
      db.prepare("UPDATE tasks SET review_count = review_count + 1, updated_at = ? WHERE id = ?").run(Date.now(), task.id);
    }

    recordStdoutChunkMs(performance.now() - chunkStart);
  });

  // stderr handler
  child.stderr?.on("data", (data: Buffer) => {
    const text = normalizeStreamChunk(data);
    if (!text.trim()) return;
    logStream.write(`[stderr] ${text}`);
    insertStderrStmt.run(task.id, text);
    ws.broadcast("cli_output", { task_id: task.id, kind: "stderr", message: text }, { taskId: task.id });

    // Loop detection: normalize and count repeated error patterns
    if (!loopDetected) {
      const normalized = normalizeStderrForLoop(text);
      if (normalized.length > 20) {
        const count = (stderrPatternCounts.get(normalized) ?? 0) + 1;
        stderrPatternCounts.set(normalized, count);
        if (count >= LOOP_THRESHOLD) {
          loopDetected = true;
          const msg = `[Loop Detection] Same error repeated ${count} times, terminating process. Pattern: ${normalized.slice(0, 200)}`;
          logStream.write(`${msg}\n`);
          insertLogStmt.run(task.id, "system", msg);
          ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: msg }], { taskId: task.id });
          child.kill("SIGTERM");
        }
      }
    }
  });

  child.on("error", (error) => {
    if (terminatedBySpawnError) return;
    terminatedBySpawnError = true;

    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
    getHeartbeatManager()?.unregisterTask(task.id);
    activeProcesses.delete(task.id);

    const finishTime = Date.now();
    const message = error instanceof Error ? error.message : String(error);

    try {
      logStream.write(`[spawn-error] ${message}\n`);
    } catch {
      // ignore secondary logging failures
    }
    logStream.end();

    db.prepare(
      "UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?"
    ).run(finishTime, finishTime, task.id);

    db.prepare(
      "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?"
    ).run(finishTime, agent.id);

    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `Process spawn failed: ${message}`);

    invalidateCaches(cache);
    const failedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task | undefined;
    ws.broadcast("task_update", failedTask ?? { id: task.id, status: "cancelled", completed_at: finishTime });
    ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });
  });

  // Process exit
  // NOTE: this handler is intentionally async so we can block on
  // parallel auto-checks (triggered at pr_review entry) before the
  // stage pipeline decides whether to advance. Node's EventEmitter
  // does not await the returned promise, which is fine — the DB
  // writes that used to be synchronous are serialized per-task by
  // the fact that each task has exactly one child process at a time.
  child.on("close", async (code) => {
    if (terminatedBySpawnError) return;

    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
    getHeartbeatManager()?.unregisterTask(task.id);
    activeProcesses.delete(task.id);
    logStream.end();

    // AO Phase 3: the parallel tester never drives task status. It only
    // records a [PARALLEL_TEST:DONE] marker so stage-pipeline can skip
    // the serial test_generation stage, flips its agent back to idle,
    // and exits. The implementer's own close handler remains the
    // authoritative source of status transitions.
    if (isParallelTester) {
      const finishTime = Date.now();
      const verdict: "pass" | "fail" = code === 0 ? "pass" : "fail";
      try {
        recordParallelTestCompletion(db, task.id, verdict);
      } catch (err) {
        insertLogStmt.run(
          task.id,
          "system",
          `Parallel tester completion logging failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      insertLogStmt.run(
        task.id,
        "system",
        `Parallel tester process exited with code ${code}. Verdict: ${verdict}`,
      );
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?",
      ).run(finishTime, agent.id);
      invalidateCaches(cache);
      ws.broadcast("agent_status", {
        id: agent.id,
        status: "idle",
        current_task_id: null,
      });
      return;
    }

    // Check for pending interactive prompt — keep task in_progress, don't finalize.
    // The process was killed when we detected the prompt, so the user can respond via UI.
    if (pendingInteractivePrompts.has(task.id) && !pendingFeedback.has(task.id)) {
      const finishTime = Date.now();
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?"
      ).run(finishTime, agent.id);
      insertLogStmt.run(task.id, "system", "Agent awaiting user input (interactive prompt). Task remains in_progress.");
      invalidateCaches(cache);
      ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });
      return;
    }

    // Check for pending feedback — respawn with --continue instead of finalizing
    const feedback = pendingFeedback.get(task.id);
    if (feedback) {
      pendingFeedback.delete(task.id);

      insertLogStmt.run(task.id, "system", "Restarting with user feedback (--resume)");
      ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: "Restarting with user feedback..." }], { taskId: task.id });

      const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task | undefined;
      const freshAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agent.id) as unknown as Agent | undefined;

      if (freshTask && freshAgent) {
        spawnAgent(db, ws, freshAgent, freshTask, {
          continuePrompt: feedback.message,
          previousStatus: feedback.previousStatus,
          cache,
        });
      }
      return;
    }

    // Context reset on timeout: instead of cancelling, save handoff and reset to inbox
    const timeoutReason = timeoutReasons.get(task.id);
    if (timeoutReason) {
      timeoutReasons.delete(task.id);

      const finishTime = Date.now();
      const timeoutMs = timeoutReason === "idle_timeout" ? TASK_RUN_IDLE_TIMEOUT_MS : TASK_RUN_HARD_TIMEOUT_MS;

      // Count previous context resets from task_logs
      const resetLogs = db.prepare(
        "SELECT COUNT(*) as cnt FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '%[Context Reset]%'"
      ).get(task.id) as { cnt: number };
      const resetCount = resetLogs.cnt;

      if (resetCount >= MAX_CONTEXT_RESETS) {
        // Max resets reached — actually cancel
        const cancelMsg = `[Context Reset] Max resets (${MAX_CONTEXT_RESETS}) reached. Cancelling task.`;
        insertLogStmt.run(task.id, "system", cancelMsg);

        db.prepare(
          "UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?"
        ).run(finishTime, finishTime, task.id);
        db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?"
        ).run(finishTime, agent.id);

        invalidateCaches(cache);
        const cancelledTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task | undefined;
        ws.broadcast("task_update", cancelledTask ?? { id: task.id, status: "cancelled", completed_at: finishTime });
        ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });

        notifyTaskStatus(task.title, "cancelled", {
          taskNumber: task.task_number ?? undefined,
          agentName: agent.name,
        });
        return;
      }

      // Extract recent assistant logs for handoff context
      const recentLogs = db.prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'assistant' ORDER BY id DESC LIMIT 10"
      ).all(task.id) as Array<{ message: string }>;
      const handoffSummary = recentLogs.map(l => l.message).reverse().join("\n").slice(0, 2000);

      const handoff = {
        phase: "context_reset",
        reason: timeoutReason,
        resetNumber: resetCount + 1,
        summary: handoffSummary || "No assistant output captured before timeout.",
      };
      insertLogStmt.run(task.id, "system", `[HANDOFF] ${JSON.stringify(handoff)}`);

      const resetMsg = `[Context Reset] ${timeoutReason === "idle_timeout" ? "Idle" : "Hard"} timeout after ${timeoutMs}ms. Resetting context for fresh agent. (reset ${resetCount + 1}/${MAX_CONTEXT_RESETS})`;
      insertLogStmt.run(task.id, "system", resetMsg);

      // Reset task to inbox for auto-dispatcher to pick up
      db.prepare(
        "UPDATE tasks SET status = 'inbox', started_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?"
      ).run(finishTime, task.id);
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?"
      ).run(finishTime, agent.id);

      invalidateCaches(cache);
      const resetTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task | undefined;
      ws.broadcast("task_update", resetTask ?? { id: task.id, status: "inbox" });
      ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });
      return;
    }

    // Feedback respawn completed: restore previous status instead of finalizing as done
    // (unless finalizeOnComplete is set, e.g. after interactive prompt response)
    if (isContinue && !finalizeOnComplete) {
      const finishTime = Date.now();
      const restoreStatus = options?.previousStatus ?? "in_progress";

      db.prepare(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?"
      ).run(restoreStatus, finishTime, task.id);

      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?"
      ).run(finishTime, agent.id);

      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
      ).run(task.id, `Feedback response complete. Restored status: ${restoreStatus}`);

      invalidateCaches(cache);
      const restoredTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task | undefined;
      ws.broadcast("task_update", restoredTask ?? { id: task.id, status: restoreStatus });
      ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });
      return;
    }

    // Reviewer panel deferral (Phase 2): when this is a review run and
    // a parallel panel session exists, only finalize once EVERY
    // reviewer has posted its verdict. The primary captures its
    // finalization work as a closure and hands it to the session; the
    // last-to-finish secondary invokes it. Without this deferral,
    // `determineNextStage` could read an incomplete log set (one
    // role's verdict missing) and silently rework the task even when
    // the missing reviewer was about to pass.
    if (isReviewRun) {
      const session = reviewerSessions.get(task.id);
      if (session) {
        session.primaryDone = true;
        if (session.secondaries.size > 0) {
          session.primaryFinalize = () => {
            // Fire-and-forget: performFinalization is async because
            // it waits for parallel auto-checks, but the caller is
            // the synchronous secondary-reviewer close handler via
            // maybeRunDeferredFinalization and does not await.
            void performFinalization(code);
          };
          insertLogStmt.run(
            task.id,
            "system",
            `[Reviewer Panel] primary reviewer finished (exit ${code}); awaiting ${session.secondaries.size} secondary reviewer(s) before task advance`,
          );
          return;
        }
        // Primary session exists but every secondary already finished —
        // nothing left to wait for, fall through to finalization.
        reviewerSessions.delete(task.id);
      }
    }

    await performFinalization(code);
  });

  /**
   * Perform the terminal side-effects for a completed primary run:
   * compute the next status, persist it, run `after_run` hooks, promote
   * review artifacts, broadcast task/agent updates, and trigger the next
   * auto-stage. Split out so review-panel coordination can defer this
   * work until every reviewer has finished posting verdicts.
   *
   * Async because Phase 1 auto-checks (tsc / lint / tests / e2e) run
   * in parallel with the LLM reviewer panel at pr_review entry; we
   * must wait for those checks to settle before the stage pipeline
   * reads `resolveCheckVerdictForTask` to decide whether to advance
   * beyond pr_review.
   */
  async function performFinalization(code: number | null): Promise<void> {
    // Gate: block until any active auto-checks run for this task
    // completes. No-op when checks are disabled or already finished.
    if (isReviewRun) {
      await waitForActiveChecks(task.id);
    }

    const finishTime = Date.now();
    const completionTask =
      (db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined) ?? task;
    let finalStatus = code === 0 ? determineCompletionStatus(db, completionTask, selfReview, isReviewRun, workflow) : "cancelled";

    // Extract and store refinement plan when refinement agent completes
    if (isRefinementRun && code === 0) {
      const refLogs = db.prepare(
        "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'assistant' AND created_at >= ? ORDER BY id ASC LIMIT 100"
      ).all(task.id, completionTask.started_at ?? 0) as Array<{ message: string }>;
      const combined = refLogs.map(l => l.message).join("\n");
      const planMatch = combined.match(/---REFINEMENT PLAN---([\s\S]*?)---END REFINEMENT---/);
      const refinementPlan = planMatch ? planMatch[0] : combined.slice(-5000);
      db.prepare("UPDATE tasks SET refinement_plan = ? WHERE id = ?").run(refinementPlan, task.id);
    }

    // Run after_run hooks (lint, format, etc.) — log failures as warnings but don't block progress
    if (code === 0 && workflow?.afterRun.length) {
      const hookResults = runWorkflowHooks(workflow.afterRun, workspace.cwd);
      for (const hr of hookResults) {
        insertLogStmt.run(task.id, "system", `[after_run] ${hr.command}: ${hr.ok ? "OK" : "WARNING"}${hr.output ? `\n${hr.output}` : ""}`);
      }
    }

    // Artifact-based handoff: log structured context for the next phase agent
    if (finalStatus === "test_generation" || finalStatus === "qa_testing" || finalStatus === "pr_review" || finalStatus === "human_review" || finalStatus === "ci_check") {
      const handoff = {
        phase: completionTask.status,
        nextPhase: finalStatus,
        filesModified: [] as string[],
        summary: `Implementation completed. Moving to ${finalStatus}.`,
      };
      insertLogStmt.run(task.id, "system", `[HANDOFF] ${JSON.stringify(handoff)}`);
    }

    if (finalStatus === "inbox") {
      db.prepare(
        "UPDATE tasks SET status = 'inbox', started_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?"
      ).run(finishTime, task.id);
    } else {
      db.prepare(
        "UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(finalStatus, finishTime, finishTime, task.id);
    }

    db.prepare(
      "UPDATE agents SET status = 'idle', current_task_id = NULL, stats_tasks_done = stats_tasks_done + CASE WHEN ? = 'done' THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?"
    ).run(finalStatus, finishTime, agent.id);

    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `Process exited with code ${code}. Status: ${finalStatus}`);

    if (code === 0 && (finalStatus === "test_generation" || finalStatus === "qa_testing" || finalStatus === "pr_review" || finalStatus === "human_review" || finalStatus === "ci_check" || finalStatus === "done")) {
      // Extract executed commands from task logs for PR verification section
      const executedCommands = extractExecutedCommands(db, task.id, task.started_at ?? 0);
      const promotion = promoteTaskReviewArtifact(completionTask, workflow, workspace, { executedCommands });

      // Fallback: when promoteTaskReviewArtifact can't run (workspaceMode
      // !== "git-worktree", or the agent created a nested repository
      // inside project_path), it returns null pr_url / leaves repository
      // detection to the caller. Scan the task's logs for any github.com
      // URLs the agent produced and use them as a best-effort fill-in.
      // This is also how newly-created repositories end up in the
      // `repository_url` column, since the at-creation-time detection
      // cannot know a path that does not yet exist.
      //
      // Scope the scan to the current run (`started_at` onward) so that
      // URLs mentioned in a previous run of the same task cannot leak
      // into the current run's detection.
      const logScan = extractGithubArtifactsFromLogs(db, task.id, {
        runStartedAt: task.started_at ?? null,
      });
      const fallbackPrUrl = promotion.prUrl ?? logScan.prUrl;
      const fallbackRepoUrl = logScan.repositoryUrl;

      db.prepare(
        `UPDATE tasks
         SET pr_url = COALESCE(?, pr_url),
             repository_url = COALESCE(?, repository_url),
             review_branch = ?,
             review_commit_sha = ?,
             review_sync_status = ?,
             review_sync_error = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(
        fallbackPrUrl,
        fallbackRepoUrl,
        promotion.branchName,
        promotion.commitSha,
        promotion.syncStatus,
        promotion.syncError,
        finishTime,
        task.id,
      );
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
      ).run(
        task.id,
        promotion.syncError
          ? `Review artifact sync: ${promotion.syncStatus} (${promotion.syncError})`
          : `Review artifact sync: ${promotion.syncStatus}${promotion.prUrl ? ` (${promotion.prUrl})` : ""}`,
      );
    }

    invalidateCaches(cache);
    const finishedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task | undefined;
    ws.broadcast("task_update", finishedTask ?? { id: task.id, status: finalStatus, completed_at: finishTime });
    ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });

    // Telegram notification for review/done/cancelled
    if (finalStatus === "test_generation" || finalStatus === "qa_testing" || finalStatus === "pr_review" || finalStatus === "human_review" || finalStatus === "ci_check" || finalStatus === "done" || finalStatus === "cancelled") {
      notifyTaskStatus(task.title, finalStatus, {
        taskNumber: task.task_number ?? undefined,
        prUrl: (finishedTask as Task | undefined)?.pr_url ?? undefined,
        agentName: agent.name,
      });
    }

    // Trigger auto-test-generation if task landed in test_generation
    if (finalStatus === "test_generation") {
      const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
      setTimeout(() => triggerAutoTestGen(db, ws, freshTask, cache), 500);
    }

    // Trigger auto-QA if task landed in qa_testing
    if (finalStatus === "qa_testing") {
      const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
      setTimeout(() => triggerAutoQa(db, ws, freshTask, cache), 500);
    }

    // Trigger auto-review if task landed in pr_review
    if (finalStatus === "pr_review") {
      const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
      // Fire parallel automated checks (tsc / lint / tests) synchronously
      // so the promise is registered in auto-checks' in-memory map before
      // any reviewer exit could race a waitForActiveChecks call. The
      // actual subprocess work happens in the background.
      triggerAutoChecks(db, ws, freshTask, cache);
      setTimeout(() => triggerAutoReview(db, ws, freshTask, cache), 500);
    }

    // human_review: no agent trigger — waits for human approval via API

    // Trigger auto-ci-check if task landed in ci_check
    if (finalStatus === "ci_check") {
      const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
      setTimeout(() => triggerAutoCiCheck(db, ws, freshTask, cache), 500);
    }
  }

  return { pid: child.pid ?? 0 };
}

export function determineCompletionStatus(
  db: DatabaseSync,
  task: Task,
  selfReview: boolean,
  reviewRun = task.review_count > 0,
  workflow: ProjectWorkflow | null = null,
): string {
  return determineNextStage(db, task, selfReview, reviewRun, workflow);
}

function getReviewArtifactCompletionBlockReason(
  promotion: ReviewArtifactPromotionResult | null,
): string | null {
  if (!promotion) {
    return "review artifact promotion was not executed";
  }

  if (promotion.syncStatus === "not_applicable") {
    return null;
  }

  if (promotion.syncError) {
    return promotion.syncError;
  }

  const missingFields: string[] = [];
  if (!promotion.branchName) missingFields.push("review_branch");
  if (!promotion.commitSha) missingFields.push("review_commit_sha");
  if (!promotion.prUrl) missingFields.push("pr_url");
  if (promotion.syncStatus !== "pr_open") missingFields.push(`review_sync_status=${promotion.syncStatus}`);

  return missingFields.length > 0
    ? `review artifact incomplete: ${missingFields.join(", ")}`
    : null;
}

export function resolveCompletionStatusAfterPromotion(
  task: Pick<Task, "status">,
  candidateStatus: Task["status"],
  selfReview: boolean,
  reviewRun: boolean,
  promotion: ReviewArtifactPromotionResult | null,
): { status: Task["status"]; blockedReason: string | null } {
  if (candidateStatus !== "pr_review" && candidateStatus !== "done") {
    return { status: candidateStatus, blockedReason: null };
  }

  const blockedReason = getReviewArtifactCompletionBlockReason(promotion);
  if (!blockedReason) {
    return { status: candidateStatus, blockedReason: null };
  }

  if (candidateStatus === "done" && (reviewRun || task.status === "pr_review")) {
    return { status: "pr_review", blockedReason };
  }

  return {
    status: selfReview ? "self_review" : "inbox",
    blockedReason,
  };
}

/**
 * Spawn a secondary (non-primary) reviewer for a parallel review panel.
 *
 * Secondary reviewers run the same review prompt (tailored to their role)
 * but their process lifecycle is simpler than the primary's:
 *  - They do NOT drive task state transitions (no status updates on close).
 *  - Their verdicts are written to task_logs and picked up by the
 *    stage-pipeline aggregator when the primary finalizes.
 *  - When the secondary finishes AFTER the primary, it invokes the
 *    primary's deferred-finalization closure so the task can advance.
 *  - When the secondary finishes BEFORE the primary, it simply records
 *    its verdict and exits — the primary's close handler will see the
 *    verdict in the logs.
 *
 * Callers MUST have called `initReviewerSession` for `task.id` before
 * invoking this function.
 */
export function spawnSecondaryReviewer(
  db: DatabaseSync,
  ws: WsHub,
  agent: Agent,
  task: Task,
  role: ReviewerRole,
  cache?: CacheService,
): void {
  const session = reviewerSessions.get(task.id);
  if (!session) {
    // Defensive: if no session exists, skip spawning. This should never
    // happen because auto-reviewer.ts always calls initReviewerSession
    // before spawnSecondaryReviewer.
    return;
  }

  const projectPath = task.project_path ?? process.cwd();
  const workflow = loadProjectWorkflow(projectPath);
  const runtimePolicy = resolveAgentRuntimePolicy(agent, workflow);

  const args = buildAgentArgs(agent.cli_provider, {
    model: agent.cli_model ?? undefined,
    reasoningLevel: agent.cli_reasoning_level ?? undefined,
    allowedTools: REVIEW_ALLOWED_TOOLS,
  });

  // Extract handoff context for the review prompt
  let handoffContext = "";
  const handoffs = db.prepare(
    "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '[HANDOFF]%' ORDER BY created_at DESC LIMIT 3"
  ).all(task.id) as Array<{ message: string }>;
  if (handoffs.length > 0) {
    handoffContext = "\n\n## Previous Phase Context\n" + handoffs.map(h => h.message.replace("[HANDOFF] ", "")).join("\n");
  }

  const prompt = buildReviewPrompt(task, { reviewerRole: role }) + handoffContext;

  const logDir = join("data", "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${task.id}-${role}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE;
  cleanEnv.PATH = withCliPathFallback(String(cleanEnv.PATH ?? ""));
  cleanEnv.NO_COLOR = "1";
  cleanEnv.FORCE_COLOR = "0";
  cleanEnv.CI = "1";
  if (!cleanEnv.TERM) cleanEnv.TERM = "dumb";

  const workspace = prepareTaskWorkspace(task, workflow);

  const child = spawn(args[0], args.slice(1), {
    cwd: workspace.cwd,
    env: cleanEnv,
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  // Track in the reviewer session (not in activeProcesses — the primary
  // owns that slot for the task). killAgent will clean up via the session.
  session.secondaries.set(agent.id, child);

  // Mark agent as working
  const now = Date.now();
  db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?").run(task.id, now, agent.id);
  invalidateCaches(cache);
  ws.broadcast("agent_status", { id: agent.id, status: "working", current_task_id: task.id });

  const insertLogStmt = db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, ?, ?)"
  );

  insertLogStmt.run(task.id, "system", `[Runtime:${role}] ${runtimePolicy.summary}`);

  // Send prompt via stdin
  if (child.stdin) {
    child.stdin.write(prompt);
    child.stdin.end();
  }

  // Idle / hard timeout for the secondary
  let idleTimer = setTimeout(() => {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
  }, TASK_RUN_IDLE_TIMEOUT_MS);
  const hardTimer = setTimeout(() => {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
  }, TASK_RUN_HARD_TIMEOUT_MS);

  // stdout handler — classify and persist to task_logs
  child.stdout?.on("data", (data: Buffer) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
    }, TASK_RUN_IDLE_TIMEOUT_MS);

    const text = normalizeStreamChunk(data);
    if (!text.trim()) return;
    logStream.write(text);

    const classified: Array<{ kind: TaskLogKind; message: string }> = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown> | null = null;
      try { obj = JSON.parse(trimmed); } catch { /* not JSON */ }
      if (obj) {
        const event = classifyEvent(agent.cli_provider, obj);
        if (isIgnoredEvent(event)) {
          // drop silently
        } else if (event) {
          classified.push({ kind: event.kind, message: event.message });
        } else {
          const MAX_RAW = 4000;
          const safe = trimmed.length > MAX_RAW
            ? `${trimmed.slice(0, MAX_RAW)}... [truncated]`
            : trimmed;
          classified.push({ kind: "stdout", message: safe });
        }
      } else {
        classified.push({ kind: "stdout", message: trimmed });
      }
    }

    if (classified.length > 0) {
      db.exec("BEGIN");
      try {
        for (const entry of classified) {
          insertLogStmt.run(task.id, entry.kind, entry.message);
        }
        db.exec("COMMIT");
      } catch {
        db.exec("ROLLBACK");
      }
      ws.broadcast(
        "cli_output",
        classified.map((e) => ({ task_id: task.id, ...e })),
        { taskId: task.id },
      );
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const text = normalizeStreamChunk(data);
    if (!text.trim()) return;
    logStream.write(`[stderr:${role}] ${text}`);
    insertLogStmt.run(task.id, "stderr", text);
  });

  child.on("error", () => {
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
    session.secondaries.delete(agent.id);
    logStream.end();

    const finishTime = Date.now();
    db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?").run(finishTime, agent.id);
    invalidateCaches(cache);
    ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });

    // If primary already finished and we're the last secondary, run deferred finalization
    maybeRunDeferredFinalization(session);
  });

  child.on("close", (code) => {
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
    session.secondaries.delete(agent.id);
    logStream.end();

    const finishTime = Date.now();
    db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?").run(finishTime, agent.id);
    insertLogStmt.run(task.id, "system", `Secondary reviewer (${role}) exited with code ${code}.`);

    invalidateCaches(cache);
    ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });

    // If primary already finished and we're the last secondary, run deferred finalization
    maybeRunDeferredFinalization(session);
  });
}

/**
 * If the primary reviewer already finished (deferred its finalization) and
 * all secondaries have exited, invoke the primary's deferred closure so the
 * task can advance. Otherwise this is a no-op.
 */
function maybeRunDeferredFinalization(session: ReviewerSession): void {
  if (session.primaryDone && session.secondaries.size === 0 && session.primaryFinalize) {
    const fn = session.primaryFinalize;
    session.primaryFinalize = null;
    reviewerSessions.delete(session.taskId);
    fn();
  }
}

export function killAgent(taskId: string, reason?: string): boolean {
  const child = activeProcesses.get(taskId);
  if (!child) return false;

  // Track timeout reason so the close handler can perform context reset
  if (reason === "idle_timeout" || reason === "hard_timeout") {
    timeoutReasons.set(taskId, reason);
  }

  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5000);
  } catch {
    // already dead
  }
  activeProcesses.delete(taskId);

  // Also kill any secondary reviewers running for this task
  const session = reviewerSessions.get(taskId);
  if (session) {
    for (const [, secondary] of session.secondaries) {
      try { secondary.kill("SIGTERM"); } catch { /* already dead */ }
    }
    reviewerSessions.delete(taskId);
  }

  return true;
}

function handleSubtaskEvent(
  db: DatabaseSync,
  ws: WsHub,
  taskId: string,
  event: SubtaskEvent,
  subtaskMap: Map<string, string>
): void {
  if (event.kind === "created") {
    const id = event.subtaskId;
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, status, cli_tool_use_id) VALUES (?, ?, ?, 'in_progress', ?)"
    ).run(id, taskId, event.title, event.toolUseId ?? null);
    if (event.toolUseId) subtaskMap.set(event.toolUseId, id);
    ws.broadcast("subtask_update", { id, task_id: taskId, title: event.title, status: "in_progress" });
  } else if (event.kind === "completed" && event.toolUseId) {
    const subtaskId = subtaskMap.get(event.toolUseId);
    if (subtaskId) {
      const now = Date.now();
      db.prepare("UPDATE subtasks SET status = 'done', completed_at = ? WHERE id = ?").run(now, subtaskId);
      ws.broadcast("subtask_update", { id: subtaskId, task_id: taskId, status: "done" });
    }
  }
}

/**
 * Check if a JSON stream object contains a tool_result for the given toolUseId.
 * This detects when the CLI internally resolved an interactive prompt
 * (e.g., ExitPlanMode auto-approved in non-interactive mode).
 */
function isToolResultForPrompt(obj: Record<string, unknown>, toolUseId: string): boolean {
  // Direct tool_result event
  if (obj.type === "tool_result") {
    return String(obj.tool_use_id ?? obj.id ?? "") === toolUseId;
  }

  // User message with tool_result content blocks
  if (obj.type === "user" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    const content = msg.content;
    if (Array.isArray(content)) {
      return content.some((block) => {
        const b = block as Record<string, unknown>;
        return b.type === "tool_result" && String(b.tool_use_id ?? "") === toolUseId;
      });
    }
  }

  return false;
}

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}
