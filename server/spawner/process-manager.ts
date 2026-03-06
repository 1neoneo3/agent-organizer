import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { buildAgentArgs, normalizeStreamChunk, withCliPathFallback } from "./cli-tools.js";
import { parseStreamLineFromObj, type SubtaskEvent } from "./output-parser.js";
import { classifyEvent, parseInteractivePrompt, type InteractivePromptData } from "./event-classifier.js";
import { buildTaskPrompt, buildReviewPrompt } from "./prompt-builder.js";
import { triggerAutoReview } from "./auto-reviewer.js";
import type { TaskLogKind } from "../types/runtime.js";
import {
  TASK_RUN_IDLE_TIMEOUT_MS,
  TASK_RUN_HARD_TIMEOUT_MS,
} from "../config/runtime.js";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";
import type { CacheService } from "../cache/cache-service.js";

const activeProcesses = new Map<string, ChildProcess>();
const pendingFeedback = new Map<string, { message: string; previousStatus: string }>();
const capturedSessionIds = new Map<string, string>(); // taskId -> claude session_id
const pendingInteractivePrompts = new Map<string, { data: InteractivePromptData; createdAt: number }>();

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
  const args = buildAgentArgs(agent.cli_provider, {
    model: agent.cli_model ?? undefined,
    reasoningLevel: agent.cli_reasoning_level ?? undefined,
    resumeSessionId,
  });

  // Determine if self-review applies (skip for continue mode)
  const selfReviewThreshold = getSetting(db, "self_review_threshold") ?? "small";
  const selfReview = !isContinue && (
    selfReviewThreshold === "all" ||
    (selfReviewThreshold === "medium" && (task.task_size === "small" || task.task_size === "medium")) ||
    (selfReviewThreshold === "small" && task.task_size === "small")
  );

  const isReviewRun = task.review_count > 0;
  const prompt = isContinue
    ? options!.continuePrompt!
    : (isReviewRun ? buildReviewPrompt(task) : buildTaskPrompt(task, { selfReview }));

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

  const projectPath = task.project_path ?? process.cwd();

  const child = spawn(args[0], args.slice(1), {
    cwd: projectPath,
    env: cleanEnv,
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  activeProcesses.set(task.id, child);

  // Update task and agent status (skip for continue — already in_progress)
  if (!isContinue) {
    const now = Date.now();
    db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?").run(now, now, task.id);
    db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?").run(task.id, now, agent.id);

    invalidateCaches(cache);
    const startedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task | undefined;
    ws.broadcast("task_update", startedTask ?? { id: task.id, status: "in_progress", started_at: now });
    ws.broadcast("agent_status", { id: agent.id, status: "working", current_task_id: task.id });
  }

  // Send prompt via stdin
  if (child.stdin) {
    child.stdin.write(prompt);
    child.stdin.end();
  }

  // Dedup: track recent assistant messages to skip duplicates from multiple event formats
  const recentAssistantMessages = new Set<string>();

  // Flag to stop processing stdout after an interactive prompt is detected and process killed
  let interactivePromptKilled = false;

  // Subtask tracking
  const subtaskMap = new Map<string, string>(); // toolUseId -> subtaskId

  // Pre-compile prepared statements (avoid re-compiling in hot data handler)
  const insertLogStmt = db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, ?, ?)"
  );

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
    for (const entry of deduped) {
      insertLogStmt.run(task.id, entry.kind, entry.message);
    }

    // Broadcast as array (consistent shape for clients)
    if (deduped.length > 0) {
      ws.broadcast("cli_output", deduped.map((e) => ({ task_id: task.id, ...e })));
    }

    // Auto-detect PR URL from agent output
    const prUrlMatch = text.match(/https:\/\/github\.com\/[^\s"'<>)]+\/pull\/\d+/);
    if (prUrlMatch) {
      db.prepare("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ? AND pr_url IS NULL").run(prUrlMatch[0], Date.now(), task.id);
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
    db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'stderr', ?)").run(task.id, text);
    ws.broadcast("cli_output", { task_id: task.id, kind: "stderr", message: text });
  });

  // Process exit
  child.on("close", (code) => {
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
      ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: "Restarting with user feedback..." }]);

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

    const finalStatus = code === 0 ? determineCompletionStatus(db, task, selfReview) : "cancelled";

    db.prepare(
      "UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?"
    ).run(finalStatus, finishTime, finishTime, task.id);

    db.prepare(
      "UPDATE agents SET status = 'idle', current_task_id = NULL, stats_tasks_done = stats_tasks_done + CASE WHEN ? = 'done' THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?"
    ).run(finalStatus, finishTime, agent.id);

    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `Process exited with code ${code}. Status: ${finalStatus}`);

    invalidateCaches(cache);
    const finishedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task | undefined;
    ws.broadcast("task_update", finishedTask ?? { id: task.id, status: finalStatus, completed_at: finishTime });
    ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });

    // Trigger auto-review if task landed in pr_review
    if (finalStatus === "pr_review") {
      const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
      setTimeout(() => triggerAutoReview(db, ws, freshTask, cache), 500);
    }
  });

  return { pid: child.pid ?? 0 };
}

function determineCompletionStatus(
  db: DatabaseSync,
  task: Task,
  selfReview: boolean
): string {
  // Auto-review completion: review_count > 0 means this was a review run
  if (task.review_count > 0) {
    const logs = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'stdout' ORDER BY id DESC LIMIT 50"
    ).all(task.id) as Array<{ message: string }>;

    const needsChanges = logs.some((l) => l.message.includes("[REVIEW:NEEDS_CHANGES]"));
    if (needsChanges) return "inbox"; // Send back for rework
    return "done"; // Review passed (or no explicit marker = pass)
  }

  if (!selfReview) {
    // Check review_mode setting
    const reviewMode = getSetting(db, "review_mode") ?? "pr_only";
    if (reviewMode === "none") return "done";
    if (reviewMode === "pr_only") return "pr_review";
    return "pr_review";
  }
  // Self-review: check if review passed
  const logs = db.prepare(
    "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'stdout' ORDER BY id DESC LIMIT 50"
  ).all(task.id) as Array<{ message: string }>;

  const passed = logs.some((l) => l.message.includes("[SELF_REVIEW:PASS]"));
  if (passed) return "done"; // Auto-approved via self-review
  return "pr_review"; // Fallback to PR review
}

export function killAgent(taskId: string, reason?: string): boolean {
  const child = activeProcesses.get(taskId);
  if (!child) return false;
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
