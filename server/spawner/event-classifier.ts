/**
 * Classify a JSON stream event from CLI output into a semantic kind
 * and extract human-readable message content.
 *
 * Returns null for events that should remain as raw 'stdout'.
 */

export type EventKind = "thinking" | "assistant" | "tool_call" | "tool_result";

// --------------- Interactive Prompt Detection ---------------

export interface InteractivePromptData {
  promptType: "exit_plan_mode" | "ask_user_question" | "text_input_request";
  toolUseId: string;
  /** The raw assistant text that triggered text_input_request detection */
  detectedText?: string;
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
  // This is the preferred detection source — it contains complete input data
  // (questions, options, allowedPrompts) unlike stream_event content_block_start
  // which only has the tool name and id.
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

  // NOTE: We intentionally do NOT detect from stream_event content_block_start.
  // That event only has tool name + id but not the full input (questions, options).
  // Detecting from it would store incomplete data (e.g., empty questions for AskUserQuestion).
  // The assistant message (above) contains the complete data and arrives in the same
  // or next stdout chunk, before the CLI can auto-resolve the prompt.

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

// --------------- Text-based Interactive Prompt Detection ---------------

// Patterns that strongly indicate the agent is requesting user input.
// These are checked against classified "assistant" text output.
const TEXT_PROMPT_PATTERNS_JA: RegExp[] = [
  /(?:指定|入力|提供|教えて|貼って|選択して|返答して|回答して)(?:ください|して(?:ほしい|もらえ))/,
  /(?:再指定|追加情報|追加入力|確認が必要)/,
  /(?:どちらにしますか|どうしますか|どれを選びますか)/,
  /(?:コマンドを|パスを|ファイルを|ディレクトリを)(?:教えて|指定して|入力して|貼って)/,
  /(?:完了条件|対象|作業ディレクトリ)を[^。]{0,30}(?:指定|教えて|入力)(?:して|ください)/,
];

const TEXT_PROMPT_PATTERNS_EN: RegExp[] = [
  /(?:please|could you|can you|would you)\s+(?:provide|specify|enter|paste|confirm|select|choose|tell me|let me know)/i,
  /(?:what|which|where|how)\s+(?:would you like|should I|do you want)/i,
  /(?:waiting for|need(?:s)?|require[sd]?)\s+(?:your|user)\s+(?:input|response|answer|confirmation|feedback|decision)/i,
  /(?:paste|type|enter)\s+(?:the|your|a)\s+(?:command|path|file|directory|value|answer)/i,
  /(?:please respond|please reply|please answer)/i,
];

function looksLikeCompletionSummary(text: string): boolean {
  return (
    // Legacy untagged verdicts
    text.includes("[REVIEW:PASS]") ||
    text.includes("[REVIEW:NEEDS_CHANGES]") ||
    // Role-tagged verdicts: [REVIEW:code:PASS], [REVIEW:security:NEEDS_CHANGES:…]
    /\[REVIEW:\w+:PASS\]/.test(text) ||
    /\[REVIEW:\w+:NEEDS_CHANGES/.test(text) ||
    (text.includes("レビューサマリー") && text.includes("### 判定")) ||
    // Refinement plan / sprint contract output — not a user prompt.
    // Guard on the start marker alone: streaming splits the block across
    // multiple events so the end marker may not yet be present.
    text.includes("---REFINEMENT PLAN---") ||
    text.includes("---SPRINT CONTRACT---")
  );
}

/**
 * Strong signal: the message ends with (or contains near the end) an
 * explicit question mark followed by a numbered list of two or more
 * options. This is unambiguously "the agent is asking the user to
 * pick" and overrides the completion-summary guard, because agents
 * sometimes post a long status report (including a `[REVIEW:PASS]`
 * bullet) AND a final "what next?" decision prompt in the same
 * message — the summary guard would otherwise swallow the prompt.
 *
 * Regression source: task #349 (Phase 2 implementation) ended with
 * `[REVIEW:PASS]` inside its report AND a trailing
 * `次のアクションをどうしますか？\n1. ... 2. ... 3. ...` decision
 * prompt; looksLikeCompletionSummary short-circuited and the task
 * stalled in human_review.
 *
 * Match shape:
 *   "...どうしますか？\n\n1. ...\n2. ..."
 *   "...What next?\n1) ...\n2) ..."
 *
 * Punctuation is intentionally generous to cover JP/CJK conventions
 * (。．、) alongside ASCII `.` and `)`.
 */
function hasExplicitOptionsPrompt(text: string): boolean {
  // Require the question mark to be followed (within a reasonable
  // distance) by two numbered items. Using [\s\S] so the regex spans
  // newlines. The `\d+` on the second marker makes sure any two
  // distinct items qualify even if option "1" has multi-line content.
  return /[?？][\s\S]{0,600}?\n\s*1[.．)、:][\s\S]{0,600}?\n\s*[2-9][.．)、:]/.test(
    text,
  );
}

/**
 * Strip complete refinement plan blocks from text so that plan prose
 * doesn't interfere with prompt detection, while text outside the
 * block (e.g. a trailing prompt) is still checked.
 */
function stripRefinementPlanBlocks(text: string): string {
  return text.replace(/---REFINEMENT PLAN---[\s\S]*?---END REFINEMENT---/g, "").trim();
}

/**
 * Strip complete SPRINT CONTRACT blocks.  Agent declarations like
 * "成果物 / 受け入れ基準 / スコープ外" are internal work-tracking,
 * not user prompts.
 */
function stripSprintContractBlocks(text: string): string {
  return text.replace(/---SPRINT CONTRACT---[\s\S]*?---END CONTRACT---/g, "").trim();
}

/**
 * Check if a classified assistant message looks like the agent is requesting user input.
 * Returns an InteractivePromptData if detected, null otherwise.
 *
 * This is a heuristic — it favors precision over recall to avoid false positives.
 * Only multi-sentence assistant messages are checked (short fragments are skipped).
 *
 * Complete refinement plan blocks are stripped before detection so that
 * plan prose doesn't trigger false positives while trailing prompts
 * outside the block are still caught. Streaming partial plan blocks
 * (start marker only) are guarded by `looksLikeCompletionSummary` and
 * the caller's `insideRefinementPlanBlock` flag.
 *
 * When `strictMode` is true, only the strong "question + numbered options"
 * signal fires; weak regex-based JA/EN patterns are skipped. This is used
 * during in_progress stage where agents routinely emit declaration-style
 * text (SPRINT CONTRACT, checklists) that weak patterns misclassify.
 */
export function detectTextInteractivePrompt(
  assistantText: string,
  options?: { strictMode?: boolean },
): InteractivePromptData | null {
  const stripped = stripRefinementPlanBlocks(assistantText);
  const textToCheck = stripSprintContractBlocks(stripped);

  // Skip very short messages — unlikely to be a genuine input request.
  // Threshold is low (10) because CJK languages pack more meaning per character.
  if (textToCheck.length < 10) return null;

  // Strong override: an explicit "question + 2+ numbered options" block
  // is unambiguously a prompt. It wins over the completion-summary
  // guard because agents sometimes finish their report with a verdict
  // tag AND a final "what next?" decision list in the same message.
  const explicitOptions = hasExplicitOptionsPrompt(textToCheck);

  if (!explicitOptions && looksLikeCompletionSummary(textToCheck)) return null;

  if (explicitOptions) {
    return {
      promptType: "text_input_request",
      toolUseId: "",
      detectedText: textToCheck,
      questions: [{ question: textToCheck }],
    };
  }

  // In strict mode, only the explicit options prompt fires.
  // Weak regex patterns are skipped to avoid false positives on
  // agent declarations (SPRINT CONTRACT, checklists, etc.)
  if (options?.strictMode) return null;

  for (const pattern of TEXT_PROMPT_PATTERNS_JA) {
    if (pattern.test(textToCheck)) {
      return {
        promptType: "text_input_request",
        toolUseId: "",
        detectedText: textToCheck,
        questions: [{ question: textToCheck }],
      };
    }
  }

  for (const pattern of TEXT_PROMPT_PATTERNS_EN) {
    if (pattern.test(textToCheck)) {
      return {
        promptType: "text_input_request",
        toolUseId: "",
        detectedText: textToCheck,
        questions: [{ question: textToCheck }],
      };
    }
  }

  return null;
}

export interface ClassifiedEvent {
  kind: EventKind;
  message: string;
}

/**
 * Sentinel returned by provider classifiers for structured events that are
 * recognized but intentionally not displayed (e.g., control events like
 * `thread.started`). Distinct from `null`, which means "unrecognized — fall
 * back to raw stdout". The process manager must treat this as "drop silently"
 * to avoid dumping large JSON blobs into the terminal view.
 */
export const CODEX_IGNORED: ClassifiedEvent = { kind: "tool_call", message: "__ignored__" };

export function classifyEvent(
  provider: string,
  obj: Record<string, unknown>
): ClassifiedEvent | null | typeof CODEX_IGNORED {
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

  // Pass through the ignored sentinel so callers can distinguish "handled
  // silently" from "unknown event".
  if (result === CODEX_IGNORED) return CODEX_IGNORED;

  // Filter out events with empty/whitespace-only messages
  if (result && !result.message.trim()) return null;

  return result;
}

/** Type guard: check whether a classify result should be silently dropped. */
export function isIgnoredEvent(ev: ClassifiedEvent | null | typeof CODEX_IGNORED): boolean {
  return ev === CODEX_IGNORED;
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
    if (!item) return CODEX_IGNORED;

    if (item.type === "agent_message" && typeof item.text === "string") {
      return { kind: "assistant", message: item.text };
    }

    // Tool result
    if (item.type === "function_call_output" || item.type === "tool_result") {
      const output = typeof item.output === "string" ? sanitizeToolOutput(item.output) : "";
      const tool = String(item.name ?? item.tool ?? "tool");
      return { kind: "tool_result", message: output ? `${tool} → ${output}` : `${tool} completed` };
    }

    // Shell command execution result (Codex gpt-5.x "command_execution" item)
    // Item shape: { type: "command_execution", command: "...", aggregated_output: "..." }
    // `aggregated_output` can be huge (full grep/rg output), so must be sanitized.
    if (item.type === "command_execution") {
      const command = typeof item.command === "string" ? item.command : "";
      const rawOutput =
        typeof item.aggregated_output === "string"
          ? item.aggregated_output
          : typeof item.output === "string"
            ? (item.output as string)
            : "";
      const summary = command ? summarizeCommand(command) : "command";
      const output = sanitizeToolOutput(rawOutput);
      return {
        kind: "tool_result",
        message: output ? `shell(${summary}) → ${output}` : `shell(${summary}) completed`,
      };
    }

    // Note: tool_call for function_call is emitted only on item.started (below)
    // to avoid duplicate events.

    return CODEX_IGNORED;
  }

  // item.started with function_call / command_execution
  if (obj.type === "item.started") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (!item) return CODEX_IGNORED;

    if (item.type === "function_call" || item.tool) {
      const tool = String(item.name ?? item.tool ?? "unknown");
      const args = item.arguments as Record<string, unknown> | undefined;
      const summary = summarizeToolInput(tool, args);
      return { kind: "tool_call", message: `Tool: ${tool}(${summary})` };
    }

    if (item.type === "command_execution") {
      const command = typeof item.command === "string" ? item.command : "";
      const summary = command ? summarizeCommand(command) : "command";
      return { kind: "tool_call", message: `shell(${summary})` };
    }

    return CODEX_IGNORED;
  }

  // Reasoning / thinking
  if (obj.type === "reasoning" || obj.type === "thinking") {
    const text = extractText(obj);
    if (text) return { kind: "thinking", message: text };
    return CODEX_IGNORED;
  }

  // Text output
  if (obj.type === "output_text" || obj.type === "assistant_message") {
    const text = extractText(obj);
    if (text) return { kind: "assistant", message: text };
    return CODEX_IGNORED;
  }

  // Known control events (no useful info to display, but should be dropped
  // rather than dumped to stdout as raw JSON)
  if (
    obj.type === "thread.started" ||
    obj.type === "thread.completed" ||
    obj.type === "turn.started" ||
    obj.type === "turn.completed" ||
    obj.type === "session.created" ||
    obj.type === "session.completed"
  ) {
    return CODEX_IGNORED;
  }

  return null;
}

/** Summarize a shell command for display (strip leading shell wrapper, truncate). */
function summarizeCommand(command: string): string {
  // Strip common `/bin/bash -lc "..."` or `bash -c '...'` wrappers
  const unwrapped = command.replace(
    /^\s*\/?\w*bash\s+-[a-z]*c\s+['"](.+)['"]?\s*$/,
    "$1",
  );
  const trimmed = unwrapped.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
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
