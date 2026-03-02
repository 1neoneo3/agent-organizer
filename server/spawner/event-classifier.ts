/**
 * Classify a JSON stream event from CLI output into a semantic kind
 * and extract human-readable message content.
 *
 * Returns null for events that should remain as raw 'stdout'.
 */

export type EventKind = "thinking" | "assistant" | "tool_call" | "tool_result";

// --------------- Interactive Prompt Detection ---------------

export interface InteractivePromptData {
  promptType: "exit_plan_mode" | "ask_user_question";
  toolUseId: string;
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string; markdown?: string }>;
    multiSelect?: boolean;
  }>;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
}

const INTERACTIVE_TOOLS: Record<string, InteractivePromptData["promptType"]> = {
  ExitPlanMode: "exit_plan_mode",
  AskUserQuestion: "ask_user_question",
};

/**
 * Parse a JSON stream object to detect interactive prompt tool calls
 * (ExitPlanMode / AskUserQuestion). Returns null if not an interactive prompt.
 */
export function parseInteractivePrompt(obj: Record<string, unknown>): InteractivePromptData | null {
  // Top-level tool_use event
  if (obj.type === "tool_use") {
    return extractFromToolUse(obj);
  }

  // assistant message with content array containing tool_use blocks
  if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use") {
          const result = extractFromToolUse(b);
          if (result) return result;
        }
      }
    }
  }

  // stream_event wrapper
  if (obj.type === "stream_event") {
    const ev = obj.event as Record<string, unknown> | undefined;
    if (ev?.type === "content_block_start") {
      const block = ev.content_block as Record<string, unknown> | undefined;
      if (block?.type === "tool_use") {
        return extractFromToolUse(block);
      }
    }
  }

  return null;
}

function extractFromToolUse(block: Record<string, unknown>): InteractivePromptData | null {
  const toolName = String(block.name ?? block.tool ?? "");
  const promptType = INTERACTIVE_TOOLS[toolName];
  if (!promptType) return null;

  const toolUseId = String(block.id ?? "");
  const input = (block.input ?? {}) as Record<string, unknown>;

  if (promptType === "ask_user_question") {
    const questions = input.questions as InteractivePromptData["questions"] | undefined;
    return { promptType, toolUseId, questions: questions ?? [] };
  }

  // exit_plan_mode
  const allowedPrompts = input.allowedPrompts as InteractivePromptData["allowedPrompts"] | undefined;
  return { promptType, toolUseId, allowedPrompts };
}

export interface ClassifiedEvent {
  kind: EventKind;
  message: string;
}

export function classifyEvent(
  provider: string,
  obj: Record<string, unknown>
): ClassifiedEvent | null {
  let result: ClassifiedEvent | null;
  switch (provider) {
    case "claude":
      result = classifyClaude(obj);
      break;
    case "codex":
      result = classifyCodex(obj);
      break;
    case "gemini":
      result = classifyGemini(obj);
      break;
    default:
      return null;
  }

  // Filter out events with empty/whitespace-only messages
  if (result && !result.message.trim()) return null;

  return result;
}

// --------------- Claude ---------------

function classifyClaude(obj: Record<string, unknown>): ClassifiedEvent | null {
  // stream_event wrapper (Claude Code --output-format stream-json)
  if (obj.type === "stream_event") {
    const ev = obj.event as Record<string, unknown> | undefined;
    if (!ev) return null;
    return classifyClaudeInnerEvent(ev);
  }

  // Top-level assistant message
  if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    const content = msg.content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          texts.push(b.text);
        }
      }
      if (texts.length > 0) {
        return { kind: "assistant", message: texts.join("\n") };
      }
    }
    return null;
  }

  // Thinking / reasoning blocks
  if (obj.type === "thinking" || obj.type === "reasoning") {
    const text = extractText(obj);
    if (text) return { kind: "thinking", message: text };
    return null;
  }

  // text type with optional part
  if (obj.type === "text") {
    const part = obj.part as Record<string, unknown> | undefined;
    if (part?.type === "reasoning" || part?.type === "thinking") {
      const text = typeof part.text === "string" ? part.text : extractText(obj);
      if (text) return { kind: "thinking", message: text };
      return null;
    }
    const text = typeof part?.text === "string" ? part.text : extractText(obj);
    if (text) return { kind: "assistant", message: text };
    return null;
  }

  // Tool use
  if (obj.type === "tool_use") {
    const tool = String(obj.tool ?? obj.name ?? "unknown");
    const input = obj.input as Record<string, unknown> | undefined;
    const summary = summarizeToolInput(tool, input);
    return { kind: "tool_call", message: `Tool: ${tool}(${summary})` };
  }

  // Tool result
  if (obj.type === "tool_result") {
    const tool = String(obj.tool ?? obj.name ?? "tool");
    const content = extractToolResultContent(obj);
    return { kind: "tool_result", message: content ? `${tool} → ${content}` : `${tool} completed` };
  }

  // result type (final answer)
  if (obj.type === "result" && typeof obj.result === "string") {
    return { kind: "assistant", message: obj.result };
  }

  return null;
}

function classifyClaudeInnerEvent(ev: Record<string, unknown>): ClassifiedEvent | null {
  // content_block_delta with text_delta → assistant text
  if (ev.type === "content_block_delta") {
    const delta = ev.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return { kind: "assistant", message: delta.text };
    }
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      return { kind: "thinking", message: delta.thinking };
    }
    return null;
  }

  // content_block_start
  if (ev.type === "content_block_start") {
    const block = ev.content_block as Record<string, unknown> | undefined;
    if (!block) return null;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      return { kind: "assistant", message: block.text };
    }
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      return { kind: "thinking", message: block.thinking };
    }
    if (block.type === "tool_use") {
      const tool = String(block.name ?? "unknown");
      return { kind: "tool_call", message: `Tool: ${tool}(starting)` };
    }
    return null;
  }

  return null;
}

// --------------- Codex ---------------

function classifyCodex(obj: Record<string, unknown>): ClassifiedEvent | null {
  // item.completed with agent_message
  if (obj.type === "item.completed") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (!item) return null;

    if (item.type === "agent_message" && typeof item.text === "string") {
      return { kind: "assistant", message: item.text };
    }

    // Tool result
    if (item.type === "function_call_output" || item.type === "tool_result") {
      const output = typeof item.output === "string" ? sanitizeToolOutput(item.output) : "";
      const tool = String(item.name ?? item.tool ?? "tool");
      return { kind: "tool_result", message: output ? `${tool} → ${output}` : `${tool} completed` };
    }

    // Note: tool_call for function_call is emitted only on item.started (below)
    // to avoid duplicate events.

    return null;
  }

  // item.started with function_call
  if (obj.type === "item.started") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (!item) return null;

    if (item.type === "function_call" || item.tool) {
      const tool = String(item.name ?? item.tool ?? "unknown");
      const args = item.arguments as Record<string, unknown> | undefined;
      const summary = summarizeToolInput(tool, args);
      return { kind: "tool_call", message: `Tool: ${tool}(${summary})` };
    }
    return null;
  }

  // Reasoning / thinking
  if (obj.type === "reasoning" || obj.type === "thinking") {
    const text = extractText(obj);
    if (text) return { kind: "thinking", message: text };
    return null;
  }

  // Text output
  if (obj.type === "output_text" || obj.type === "assistant_message") {
    const text = extractText(obj);
    if (text) return { kind: "assistant", message: text };
    return null;
  }

  return null;
}

// --------------- Gemini ---------------

function classifyGemini(obj: Record<string, unknown>): ClassifiedEvent | null {
  // Message with role=assistant or model
  if (obj.type === "message" && (obj.role === "assistant" || obj.role === "model")) {
    const text = typeof obj.content === "string" ? obj.content : extractText(obj);
    if (text) return { kind: "assistant", message: text };
    return null;
  }

  // Function call
  if (obj.type === "function_call" || obj.type === "tool_call") {
    const tool = String(obj.name ?? obj.tool ?? "unknown");
    const args = (obj.arguments ?? obj.args) as Record<string, unknown> | undefined;
    const summary = summarizeToolInput(tool, args);
    return { kind: "tool_call", message: `Tool: ${tool}(${summary})` };
  }

  // Function result
  if (obj.type === "function_response" || obj.type === "tool_result") {
    const tool = String(obj.name ?? obj.tool ?? "tool");
    const output = extractToolResultContent(obj);
    return { kind: "tool_result", message: output ? `${tool} → ${output}` : `${tool} completed` };
  }

  // Thinking
  if (obj.type === "thinking" || obj.type === "reasoning") {
    const text = extractText(obj);
    if (text) return { kind: "thinking", message: text };
    return null;
  }

  return null;
}

// --------------- Helpers ---------------

const MAX_TOOL_RESULT_LENGTH = 500;
const MAX_TOOL_INPUT_LENGTH = 200;

function extractText(obj: Record<string, unknown>): string {
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  const part = obj.part as Record<string, unknown> | undefined;
  if (part && typeof part.text === "string") return part.text;
  return "";
}

/**
 * Extract displayable content from a tool result event.
 * Handles: string content, array content blocks, binary/encoded data.
 */
function extractToolResultContent(obj: Record<string, unknown>): string {
  // Direct string content or output
  if (typeof obj.content === "string") return sanitizeToolOutput(obj.content);
  if (typeof obj.output === "string") return sanitizeToolOutput(obj.output);

  // Array of content blocks (Claude format: [{type: "text", text: "..."}, ...])
  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const block of obj.content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "image" || b.type === "image_url") {
        parts.push("[image]");
      } else if (typeof b.text === "string") {
        parts.push(b.text);
      }
    }
    if (parts.length > 0) return sanitizeToolOutput(parts.join("\n"));
  }

  // Nested result field
  if (typeof obj.result === "string") return sanitizeToolOutput(obj.result);

  return "";
}

/**
 * Sanitize and truncate tool output for display.
 * Detects binary/encoded data and replaces with a placeholder.
 */
function sanitizeToolOutput(raw: string): string {
  if (!raw) return "";

  // Detect base64-encoded data (long unbroken strings with base64 alphabet)
  if (raw.length > 200 && /^[A-Za-z0-9+/=]{200,}$/.test(raw.slice(0, 300))) {
    return `[base64 data, ${formatBytes(Math.ceil(raw.length * 0.75))}]`;
  }

  // Detect binary/non-printable content (high ratio of control chars)
  const sample = raw.slice(0, 500);
  const controlChars = sample.replace(/[\x20-\x7E\n\r\t]/g, "").length;
  if (controlChars > sample.length * 0.3) {
    return `[binary data, ${formatBytes(raw.length)}]`;
  }

  // Detect hex dump patterns
  if (/^([0-9a-fA-F]{2}\s*){20,}/.test(raw.slice(0, 200))) {
    return `[hex data, ${formatBytes(Math.floor(raw.length / 3))}]`;
  }

  return truncate(raw.trim(), MAX_TOOL_RESULT_LENGTH);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function summarizeToolInput(_tool: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";

  // Common patterns for readable summaries
  if (typeof input.command === "string") return truncate(input.command, MAX_TOOL_INPUT_LENGTH);
  if (typeof input.query === "string") return truncate(input.query, MAX_TOOL_INPUT_LENGTH);
  if (typeof input.file_path === "string") return truncate(input.file_path, MAX_TOOL_INPUT_LENGTH);
  if (typeof input.path === "string") return truncate(input.path, MAX_TOOL_INPUT_LENGTH);
  if (typeof input.pattern === "string") return truncate(input.pattern, MAX_TOOL_INPUT_LENGTH);
  if (typeof input.prompt === "string") return truncate(input.prompt, MAX_TOOL_INPUT_LENGTH);
  if (typeof input.description === "string") return truncate(input.description, MAX_TOOL_INPUT_LENGTH);
  if (typeof input.url === "string") return truncate(input.url, MAX_TOOL_INPUT_LENGTH);

  // Fallback: first string value
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val.length > 0) {
      return truncate(val, MAX_TOOL_INPUT_LENGTH);
    }
  }

  return "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Try to break at a word boundary for readability
  const cutoff = s.lastIndexOf(" ", max);
  const breakAt = cutoff > max * 0.7 ? cutoff : max;
  return s.slice(0, breakAt) + "…";
}
