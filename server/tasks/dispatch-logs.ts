import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../types/runtime.js";
import type { WsHub } from "../ws/hub.js";

const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

function isForeignKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { errcode?: unknown }).errcode;
  return code === SQLITE_CONSTRAINT_FOREIGNKEY;
}

export function writeDispatchLog(
  db: DatabaseSync,
  ws: WsHub,
  task: Task,
  message: string,
  prefix = "[Auto Dispatch]",
): void {
  const fullMessage = `${prefix} ${message}`;

  try {
    const lastLog = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY id DESC LIMIT 1",
    ).get(task.id) as { message: string } | undefined;

    if (lastLog?.message === fullMessage) {
      return;
    }

    const now = Date.now();
    db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)")
      .run(task.id, fullMessage);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, task.id);
    ws.broadcast(
      "cli_output",
      [{ task_id: task.id, kind: "system", message: fullMessage }],
      { taskId: task.id },
    );
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return;
    }
    throw error;
  }
}
