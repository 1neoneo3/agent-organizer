import { randomUUID } from "node:crypto";

export interface SubtaskEvent {
  kind: "created" | "completed";
  subtaskId: string;
  title: string;
  toolUseId?: string;
}

/**
 * Parse a single JSON line from CLI stream output.
 * Returns a subtask event if detected, null otherwise.
 */
export function parseStreamLine(
  provider: string,
  line: string
): SubtaskEvent | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  switch (provider) {
    case "claude":
      return parseClaudeEvent(obj);
    case "codex":
      return parseCodexEvent(obj);
    case "gemini":
      return parseGeminiEvent(obj);
    default:
      return null;
  }
}

function parseClaudeEvent(obj: Record<string, unknown>): SubtaskEvent | null {
  // Claude Code: tool_use with Task tool = subtask created
  if (obj.type === "tool_use" && obj.tool === "Task") {
    const input = obj.input as Record<string, unknown> | undefined;
    return {
      kind: "created",
      subtaskId: randomUUID(),
      title: String(input?.description ?? input?.prompt ?? "Subtask"),
      toolUseId: String(obj.tool_use_id ?? ""),
    };
  }
  // Claude Code: tool_result for Task tool = subtask completed
  if (obj.type === "tool_result" && obj.tool === "Task") {
    return {
      kind: "completed",
      subtaskId: "",
      title: "",
      toolUseId: String(obj.tool_use_id ?? ""),
    };
  }
  return null;
}

function parseCodexEvent(obj: Record<string, unknown>): SubtaskEvent | null {
  if (obj.type === "item.started") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (item?.tool === "spawn_agent") {
      return {
        kind: "created",
        subtaskId: randomUUID(),
        title: String(
          (item.arguments as Record<string, unknown>)?.prompt ?? "Subtask"
        ),
        toolUseId: String(item.id ?? ""),
      };
    }
  }
  if (obj.type === "item.completed") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (item?.tool === "spawn_agent") {
      return {
        kind: "completed",
        subtaskId: "",
        title: "",
        toolUseId: String(item.id ?? ""),
      };
    }
  }
  return null;
}

function parseGeminiEvent(obj: Record<string, unknown>): SubtaskEvent | null {
  if (obj.type === "message" && typeof obj.content === "string") {
    try {
      const plan = JSON.parse(obj.content);
      if (Array.isArray(plan.subtasks)) {
        // Gemini sends all subtasks at once in a plan
        return {
          kind: "created",
          subtaskId: randomUUID(),
          title: String(plan.subtasks[0]?.title ?? "Plan subtask"),
        };
      }
    } catch {
      // not a plan message
    }
  }
  return null;
}
