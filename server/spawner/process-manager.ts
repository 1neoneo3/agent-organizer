import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { buildAgentArgs, normalizeStreamChunk, withCliPathFallback, REVIEW_ALLOWED_TOOLS } from "./cli-tools.js";
import { runExplorePhase } from "./explore-phase.js";
import { parseStreamLineFromObj, type SubtaskEvent } from "./output-parser.js";
import { classifyEvent, parseInteractivePrompt, detectTextInteractivePrompt, type InteractivePromptData } from "./event-classifier.js";
import { buildTaskPrompt, buildReviewPrompt, buildQaPrompt, buildTestGenerationPrompt, buildPreDeployPrompt } from "./prompt-builder.js";
import { triggerAutoReview } from "./auto-reviewer.js";
import { triggerAutoQa } from "./auto-qa.js";
import { triggerAutoTestGen } from "./auto-test-gen.js";
import { triggerAutoPreDeploy } from "./auto-pre-deploy.js";
import { loadProjectWorkflow, type ProjectWorkflow } from "../workflow/loader.js";
import { resolveAgentRuntimePolicy } from "../workflow/runtime-policy.js";
import { determineNextStage } from "../workflow/stage-pipeline.js";
import { notifyTaskStatus } from "../notify/telegram.js";
import type { TaskLogKind } from "../types/runtime.js";
import {
  TASK_RUN_IDLE_TIMEOUT_MS,
  TASK_RUN_HARD_TIMEOUT_MS,
} from "../config/runtime.js";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import type { CacheService } from "../cache/cache-service.js";
import { prepareTaskWorkspace } from "../workflow/workspace-manager.js";
import { promoteTaskReviewArtifact, type ReviewArtifactPromotionResult } from "../workflow/review-artifact.js";
import { runWorkflowHooks } from "../workflow/hooks.js";

const activeProcesses = new Map<string, ChildProcess>();
const pendingFeedback = new Map<string, { message: string; previousStatus: string }>();
const capturedSessionIds = new Map<string, string>(); // taskId -> claude session_id
const pendingInteractivePrompts = new Map<string, { data: InteractivePromptData; createdAt: number }>();
const timeoutReasons = new Map<string, "idle_timeout" | "hard_timeout">(); // taskId -> timeout reason

const MAX_CONTEXT_RESETS = 3;

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
  options?: { continuePrompt?: string; previousStatus?: string; cache?: CacheService; finalizeOnComplete?: boolean }
): { pid: number } {
  const cache = options?.cache;
  const isContinue = !!options?.continuePrompt;
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
  const isTestGenRun = task.status === "test_generation";
  const isPreDeployRun = task.status === "pre_deploy";

  // Restrict tools for review/QA/pre-deploy phases (read-only)
  const allowedTools = (isReviewRun || isQaRun || isPreDeployRun)
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
  if ((isQaRun || isReviewRun || isTestGenRun || isPreDeployRun) && !isContinue) {
    const handoffs = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '[HANDOFF]%' ORDER BY created_at DESC LIMIT 3"
    ).all(task.id) as Array<{ message: string }>;
    if (handoffs.length > 0) {
      handoffContext = "\n\n## Previous Phase Context\n" + handoffs.map(h => h.message.replace("[HANDOFF] ", "")).join("\n");
    }
  }

  // Run Explore phase before Implement (if enabled and applicable)
  let exploreContext = "";
  if (!isContinue && !isQaRun && !isReviewRun && !isTestGenRun && !isPreDeployRun) {
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
    : (isTestGenRun
      ? buildTestGenerationPrompt(task, workflow?.projectType ?? "generic") + handoffContext
      : (isQaRun
        ? buildQaPrompt(task, workflow?.projectType ?? "generic") + handoffContext
        : (isPreDeployRun
          ? buildPreDeployPrompt(task) + handoffContext
          : (isReviewRun
            ? buildReviewPrompt(task) + handoffContext
            : buildTaskPrompt(task, { selfReview, workflow, runtimePolicy }) + exploreContext))));

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
    // Preserve current status for QA/review/test_generation/pre_deploy runs — only set in_progress for inbox tasks
    const currentStatus = task.status;
    const shouldSetInProgress = currentStatus === "inbox";
    if (shouldSetInProgress) {
      db.prepare("UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?").run(agent.id, now, now, task.id);
    } else {
      db.prepare("UPDATE tasks SET assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?").run(agent.id, now, now, task.id);
    }
    db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?").run(task.id, now, agent.id);

    invalidateCaches(cache);
    const startedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task | undefined;
    ws.broadcast("task_update", startedTask ?? { id: task.id, status: shouldSetInProgress ? "in_progress" : currentStatus, started_at: now });
    ws.broadcast("agent_status", { id: agent.id, status: "working", current_task_id: task.id });
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

  // stdout handler
  child.stdout?.on("data", (data: Buffer) => {
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
        if (event) {
          classified.push({ kind: event.kind, message: event.message });
        } else {
          classified.push({ kind: "stdout", message: trimmed });
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
  child.on("close", (code) => {
    if (terminatedBySpawnError) return;

    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
    activeProcesses.delete(task.id);
    logStream.end();

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

    const finishTime = Date.now();

    // Feedback respawn completed: restore previous status instead of finalizing as done
    // (unless finalizeOnComplete is set, e.g. after interactive prompt response)
    if (isContinue && !finalizeOnComplete) {
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

    const completionTask =
      (db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined) ?? task;
    let finalStatus = code === 0 ? determineCompletionStatus(db, completionTask, selfReview, isReviewRun, workflow) : "cancelled";

    // Run after_run hooks (lint, format, etc.) — log failures as warnings but don't block progress
    if (code === 0 && workflow?.afterRun.length) {
      const hookResults = runWorkflowHooks(workflow.afterRun, workspace.cwd);
      for (const hr of hookResults) {
        insertLogStmt.run(task.id, "system", `[after_run] ${hr.command}: ${hr.ok ? "OK" : "WARNING"}${hr.output ? `\n${hr.output}` : ""}`);
      }
    }

    // Artifact-based handoff: log structured context for the next phase agent
    if (finalStatus === "test_generation" || finalStatus === "qa_testing" || finalStatus === "pr_review" || finalStatus === "human_review" || finalStatus === "pre_deploy") {
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

    if (code === 0 && (finalStatus === "test_generation" || finalStatus === "qa_testing" || finalStatus === "pr_review" || finalStatus === "human_review" || finalStatus === "pre_deploy" || finalStatus === "done")) {
      // Extract executed commands from task logs for PR verification section
      const executedCommands = extractExecutedCommands(db, task.id, task.started_at ?? 0);
      const promotion = promoteTaskReviewArtifact(completionTask, workflow, workspace, { executedCommands });
      db.prepare(
        `UPDATE tasks
         SET pr_url = COALESCE(?, pr_url),
             review_branch = ?,
             review_commit_sha = ?,
             review_sync_status = ?,
             review_sync_error = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(
        promotion.prUrl,
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
    if (finalStatus === "test_generation" || finalStatus === "qa_testing" || finalStatus === "pr_review" || finalStatus === "human_review" || finalStatus === "pre_deploy" || finalStatus === "done" || finalStatus === "cancelled") {
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
      setTimeout(() => triggerAutoReview(db, ws, freshTask, cache), 500);
    }

    // human_review: no agent trigger — waits for human approval via API

    // Trigger auto-pre-deploy if task landed in pre_deploy
    if (finalStatus === "pre_deploy") {
      const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
      setTimeout(() => triggerAutoPreDeploy(db, ws, freshTask, cache), 500);
    }
  });

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
