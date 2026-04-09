/**
 * Convert stream-json log lines into human-readable plain text.
 * Ported from claw-empire's pretty-stream-json.ts.
 * Handles Claude, Codex, and Gemini stream formats.
 */
export function prettyStreamJson(raw: string, opts: { includeReasoning?: boolean } = {}): string {
  const chunks: string[] = [];
  let sawJson = false;
  let sawClaudeTextDelta = false;
  const includeReasoning = opts.includeReasoning === true;
  const pushReasoningChunk = (text: string): void => {
    if (!text) return;
    pushMessageChunk(`[reasoning] ${text}`);
  };
  const pushMessageChunk = (text: string): void => {
    if (!text) return;
    if (chunks.length > 0 && !chunks[chunks.length - 1].endsWith("\n")) {
      chunks.push("\n");
    }
    chunks.push(text);
    if (!text.endsWith("\n")) {
      chunks.push("\n");
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith("{")) continue;

    try {
      const j: any = JSON.parse(t);
      sawJson = true;

      // Claude Code: stream_event with text_delta
      if (j.type === "stream_event") {
        const ev = j.event;
        if (ev?.type === "content_block_delta" && ev?.delta?.type === "text_delta") {
          sawClaudeTextDelta = true;
          chunks.push(String(ev.delta.text ?? ""));
          continue;
        }
        if (ev?.type === "content_block_start" && ev?.content_block?.type === "text" && ev?.content_block?.text) {
          chunks.push(String(ev.content_block.text));
          continue;
        }
        continue;
      }

      // Claude: assistant message
      if (j.type === "assistant" && j.message?.content) {
        let assistantText = "";
        for (const block of j.message.content) {
          if (block.type === "text" && block.text && !sawClaudeTextDelta) {
            assistantText += String(block.text);
          }
        }
        pushMessageChunk(assistantText);
        continue;
      }

      // Generic result
      if (j.type === "result" && j.result) {
        pushMessageChunk(String(j.result));
        continue;
      }

      // Generic message with role=assistant
      if (j.type === "message" && j.role === "assistant" && j.content) {
        pushMessageChunk(String(j.content));
        continue;
      }

      // Codex: item.completed
      if (j.type === "item.completed" && j.item) {
        const item = j.item;
        if (item.type === "agent_message" && item.text) {
          pushMessageChunk(String(item.text));
        }
        continue;
      }

      // text type with optional part
      if (j.type === "text") {
        if (j.part?.type === "reasoning" || j.part?.type === "thinking") {
          if (!includeReasoning) continue;
          const reasoningVal =
            typeof j.part?.text === "string" ? j.part.text : typeof j.text === "string" ? j.text : "";
          if (reasoningVal) pushReasoningChunk(String(reasoningVal));
          continue;
        }
        const textVal = typeof j.part?.text === "string" ? j.part.text : typeof j.text === "string" ? j.text : "";
        if (textVal) chunks.push(String(textVal));
        continue;
      }

      // thinking / reasoning blocks
      if (j.type === "thinking" || j.type === "reasoning") {
        if (includeReasoning) {
          const reasoningVal =
            typeof j.part?.text === "string"
              ? j.part.text
              : typeof j.text === "string"
                ? j.text
                : typeof j.content === "string"
                  ? j.content
                  : "";
          if (reasoningVal) pushReasoningChunk(String(reasoningVal));
        }
        continue;
      }

      // content type
      if (j.type === "content" && (j.content || j.text)) {
        chunks.push(String(j.content ?? j.text));
        continue;
      }

      // skip known non-text events
      if (j.type === "step_finish" || j.type === "step-finish") {
        continue;
      }
      if ((j.type === "tool_use" || j.type === "tool_result") && j.part) {
        continue;
      }

      // Fallback: role=assistant with content
      if (j.role === "assistant") {
        if (typeof j.content === "string") {
          pushMessageChunk(j.content);
        } else if (Array.isArray(j.content)) {
          const parts: string[] = [];
          for (const part of j.content) {
            if (typeof part === "string") {
              parts.push(part);
            } else if (part && typeof part.text === "string") {
              parts.push(part.text);
            }
          }
          pushMessageChunk(parts.join("\n"));
        }
        continue;
      }

      // assistant_message / output_text
      if (typeof j.text === "string" && (j.type === "assistant_message" || j.type === "output_text")) {
        pushMessageChunk(j.text);
        continue;
      }
    } catch {
      // malformed stream-json line
    }
  }

  if (!sawJson) {
    return unescapeJsonText(raw.trim());
  }

  const stitched = chunks.join("");
  const normalized = unescapeJsonText(stitched);

  return normalized;
}

function unescapeJsonText(text: string): string {
  // Handle multi-level JSON escaping by processing from deepest level outward.
  // Raw text may contain \\\\n (4 chars), \\n (3 chars), or \n (2 chars) for newlines.
  // Process longest patterns first, then shorter ones.
  const result = text
    .replace(/\\\\\\\\n/g, "\n")   // \\\\n (5 chars: \,\,\,\,n) → newline
    .replace(/\\\\\\\\t/g, "\t")
    .replace(/\\\\\\\\"/g, '"')
    .replace(/\\\\n/g, "\n")       // \\n (3 chars: \,\,n) → newline
    .replace(/\\\\t/g, "\t")
    .replace(/\\\\"/g, '"')
    .replace(/\\n/g, "\n")         // \n (2 chars: \,n) → newline
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");       // \\ → \ (cleanup remaining double backslashes)
  return result
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
