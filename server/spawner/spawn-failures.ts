import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../types/runtime.js";
import type { WsHub } from "../ws/hub.js";
import { pickTaskUpdate } from "../ws/update-payloads.js";
import type { WorkflowHookResult } from "../workflow/hooks.js";

export type SpawnFailureCode =
  | "before_run_failed"
  | "runtime_rate_limit"
  | "runtime_provider_overloaded"
  | "runtime_auth_expired"
  | "runtime_oom"
  | "runtime_playwright_mcp_failed"
  | "workspace_not_git_repository"
  | "workspace_project_path_not_toplevel"
  | "workspace_repository_mismatch";

export class SpawnFailureError extends Error {
  readonly code: SpawnFailureCode;
  readonly retryable: boolean;

  constructor(code: SpawnFailureCode, message: string, retryable = false) {
    super(message);
    this.name = "SpawnFailureError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class SpawnPreflightError extends SpawnFailureError {
  constructor(code: SpawnFailureCode, message: string, retryable = false) {
    super(code, message, retryable);
    this.name = "SpawnPreflightError";
  }
}

export interface RuntimeFailureInput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  output?: string;
  errorMessage?: string;
}

export function createBeforeRunFailureError(results: WorkflowHookResult[]): SpawnPreflightError {
  const failed = results.filter((result) => !result.ok);
  const summary = failed
    .map((result) => result.command)
    .join(", ");
  return new SpawnPreflightError(
    "before_run_failed",
    `before_run failed: ${summary}`,
    false,
  );
}

export function classifyRuntimeFailure(input: RuntimeFailureInput): SpawnFailureError | null {
  const haystack = [
    input.errorMessage ?? "",
    input.stderr,
    input.output ?? "",
  ]
    .join("\n")
    .toLowerCase();

  if (
    /playwright/.test(haystack) &&
    /\bmcp\b/.test(haystack) &&
    /(failed to start|startup failed|timed out|timeout|could not start|transport closed|connection closed)/.test(haystack)
  ) {
    return new SpawnFailureError("runtime_playwright_mcp_failed", "playwright MCP startup failed", false);
  }

  if (
    /(authentication failed|invalid api key|api key .*invalid|unauthorized|not authenticated|login required|please run .*login|session expired|token expired|expired token|reauth|re-auth|auth.*expired)/.test(haystack)
  ) {
    return new SpawnFailureError("runtime_auth_expired", "authentication expired or invalid", false);
  }

  if (
    /\b429\b/.test(haystack) ||
    /rate limit/.test(haystack) ||
    /too many requests/.test(haystack) ||
    /quota exceeded/.test(haystack)
  ) {
    return new SpawnFailureError("runtime_rate_limit", "provider rate limited the run", true);
  }

  if (
    /\b529\b/.test(haystack) ||
    /server overloaded/.test(haystack) ||
    /service unavailable/.test(haystack) ||
    /temporarily unavailable/.test(haystack) ||
    /\boverloaded\b/.test(haystack)
  ) {
    return new SpawnFailureError("runtime_provider_overloaded", "provider temporarily overloaded", true);
  }

  if (
    input.signal === "SIGKILL" ||
    /out of memory/.test(haystack) ||
    /heap out of memory/.test(haystack) ||
    /memory limit exceeded/.test(haystack) ||
    /\boom\b/.test(haystack)
  ) {
    return new SpawnFailureError("runtime_oom", "process was killed by memory pressure", true);
  }

  return null;
}

export function computeTransientRetryDelayMs(attempt: number, baseDelayMs = 10_000): number {
  const normalized = Math.max(1, attempt);
  return baseDelayMs * (2 ** (normalized - 1));
}

export function classifySpawnFailure(error: unknown): SpawnFailureError | null {
  if (error instanceof SpawnFailureError) {
    return error;
  }
  return null;
}


export interface HandleSpawnFailureOptions {
  source: string;
}

export interface HandleSpawnFailureResult {
  handled: boolean;
  retryable: boolean;
  code: SpawnFailureCode | null;
  message: string;
}

export function handleSpawnFailure(
  db: DatabaseSync,
  ws: WsHub,
  taskId: string,
  error: unknown,
  options: HandleSpawnFailureOptions,
): HandleSpawnFailureResult {
  const classified = classifySpawnFailure(error);
  const message = error instanceof Error ? error.message : String(error);

  if (!classified) {
    return {
      handled: false,
      retryable: true,
      code: null,
      message,
    };
  }

  if (classified.retryable) {
    return {
      handled: false,
      retryable: true,
      code: classified.code,
      message: `${options.source}: ${classified.message}`,
    };
  }

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
  if (!task) {
    return {
      handled: true,
      retryable: classified.retryable,
      code: classified.code,
      message: `${options.source}: ${classified.message}`,
    };
  }

  const now = Date.now();
  const logMessage =
    `${options.source}: ${classified.message}. ` +
    "Moved to human_review for manual intervention.";

  db.prepare(
    "UPDATE tasks SET status = 'human_review', started_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?",
  ).run(now, now, task.id);

  if (task.assigned_agent_id) {
    db.prepare(
      "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?",
    ).run(now, task.assigned_agent_id);
    ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
  }

  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
  ).run(task.id, logMessage);

  ws.broadcast(
    "task_update",
    pickTaskUpdate(
      { id: task.id, status: "human_review", started_at: null, completed_at: now, updated_at: now },
      ["status", "started_at", "completed_at", "updated_at"],
    ),
  );

  return {
    handled: true,
    retryable: classified.retryable,
    code: classified.code,
    message: logMessage,
  };
}

export function formatSpawnFailureForUser(error: unknown): string {
  const classified = classifySpawnFailure(error);
  return classified?.message ?? (error instanceof Error ? error.message : String(error));
}

export function createHookFailureFromCommands(commands: string[]): SpawnPreflightError {
  return new SpawnPreflightError(
    "before_run_failed",
    `before_run failed: ${commands.join(", ")}`,
    false,
  );
}
