import type { DatabaseSync } from "node:sqlite";
import type { CacheService } from "../cache/cache-service.js";
import type { Task } from "../types/runtime.js";
import type { WsHub } from "../ws/hub.js";
import type { WorkflowHookResult } from "../workflow/hooks.js";

export type SpawnFailureCode = "before_run_failed";

export class SpawnPreflightError extends Error {
  readonly code: SpawnFailureCode;
  readonly retryable: boolean;

  constructor(code: SpawnFailureCode, message: string, retryable = false) {
    super(message);
    this.name = "SpawnPreflightError";
    this.code = code;
    this.retryable = retryable;
  }
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

export function classifySpawnFailure(error: unknown): SpawnPreflightError | null {
  if (error instanceof SpawnPreflightError) {
    return error;
  }
  return null;
}

function invalidateCaches(cache?: CacheService): void {
  if (!cache) return;
  cache.invalidatePattern("tasks:*");
  cache.del("agents:all");
}

export interface HandleSpawnFailureOptions {
  cache?: CacheService;
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

  invalidateCaches(options.cache);
  const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined;
  ws.broadcast("task_update", updatedTask ?? { id: task.id, status: "human_review", completed_at: now });

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
