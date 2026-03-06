import type { TaskLog } from "../../types/index.js";

export const MAX_LIVE_LOGS = 500;

export function appendLiveLogs(
  currentLogs: TaskLog[],
  incoming: Array<{ task_id: string; kind: TaskLog["kind"]; message: string }>,
  now = Date.now(),
): TaskLog[] {
  if (incoming.length === 0) {
    return currentLogs;
  }

  const appended = [
    ...currentLogs,
    ...incoming.map((entry, index) => ({
      id: now + index,
      task_id: entry.task_id,
      kind: entry.kind,
      message: entry.message,
      created_at: now + index,
    })),
  ];

  if (appended.length <= MAX_LIVE_LOGS) {
    return appended;
  }

  return appended.slice(-MAX_LIVE_LOGS);
}

export function countLogsByTab(logs: TaskLog[]): Record<"terminal" | "all" | "output", number> {
  return {
    terminal: 0,
    all: logs.length,
    output: logs.length,
  };
}

function formatTerminalChunk(entry: { kind: TaskLog["kind"]; message: string }): string {
  const message = entry.message.trimEnd();
  if (!message) {
    return "";
  }

  switch (entry.kind) {
    case "stderr":
      return `[stderr] ${message}`;
    case "system":
      return `[system] ${message}`;
    case "thinking":
    case "tool_call":
    case "tool_result":
      return "";
    case "assistant":
    case "stdout":
    default:
      return message;
  }
}

export function appendTerminalText(
  currentText: string,
  incoming: Array<{ kind: TaskLog["kind"]; message: string }>,
): string {
  if (incoming.length === 0) {
    return currentText;
  }

  const chunks = incoming
    .map((entry) => formatTerminalChunk(entry))
    .filter((chunk) => chunk.length > 0);

  if (chunks.length === 0) {
    return currentText;
  }

  const appended = chunks.join("\n");
  if (!currentText) {
    return `${appended}\n`;
  }

  const separator = currentText.endsWith("\n") ? "" : "\n";
  return `${currentText}${separator}${appended}\n`;
}
