import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { buildAgentArgs, normalizeStreamChunk, withCliPathFallback } from "./cli-tools.js";
import { parseStreamLine, type SubtaskEvent } from "./output-parser.js";
import { buildTaskPrompt } from "./prompt-builder.js";
import {
  TASK_RUN_IDLE_TIMEOUT_MS,
  TASK_RUN_HARD_TIMEOUT_MS,
} from "../config/runtime.js";
import type { WsHub } from "../ws/hub.js";
import type { Agent, Task } from "../types/runtime.js";

const activeProcesses = new Map<string, ChildProcess>();

export function getActiveProcesses(): Map<string, ChildProcess> {
  return activeProcesses;
}

export function spawnAgent(
  db: DatabaseSync,
  ws: WsHub,
  agent: Agent,
  task: Task
): { pid: number } {
  const args = buildAgentArgs(agent.cli_provider, {
    model: agent.cli_model ?? undefined,
    reasoningLevel: agent.cli_reasoning_level ?? undefined,
  });

  // Determine if self-review applies
  const selfReviewThreshold = getSetting(db, "self_review_threshold") ?? "small";
  const selfReview =
    selfReviewThreshold === "all" ||
    (selfReviewThreshold === "medium" && (task.task_size === "small" || task.task_size === "medium")) ||
    (selfReviewThreshold === "small" && task.task_size === "small");

  const prompt = buildTaskPrompt(task, { selfReview });

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

  // Update task and agent status
  const now = Date.now();
  db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?").run(now, now, task.id);
  db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?").run(task.id, now, agent.id);

  ws.broadcast("task_update", { id: task.id, status: "in_progress", started_at: now });
  ws.broadcast("agent_status", { id: agent.id, status: "working", current_task_id: task.id });

  // Send prompt via stdin
  if (child.stdin) {
    child.stdin.write(prompt);
    child.stdin.end();
  }

  // Subtask tracking
  const subtaskMap = new Map<string, string>(); // toolUseId -> subtaskId

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
    clearTimeout(idleTimer);
    idleTimer = resetIdleTimer();

    const text = normalizeStreamChunk(data);
    if (!text.trim()) return;

    // Log to file
    logStream.write(text);

    // Save to DB
    db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'stdout', ?)").run(task.id, text);

    // Broadcast
    ws.broadcast("cli_output", { task_id: task.id, kind: "stdout", message: text });

    // Parse for subtasks
    for (const line of text.split("\n")) {
      const event = parseStreamLine(agent.cli_provider, line.trim());
      if (event) handleSubtaskEvent(db, ws, task.id, event, subtaskMap);
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

    const finishTime = Date.now();
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

    ws.broadcast("task_update", { id: task.id, status: finalStatus, completed_at: finishTime });
    ws.broadcast("agent_status", { id: agent.id, status: "idle", current_task_id: null });
  });

  return { pid: child.pid ?? 0 };
}

function determineCompletionStatus(
  db: DatabaseSync,
  task: Task,
  selfReview: boolean
): string {
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

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}
