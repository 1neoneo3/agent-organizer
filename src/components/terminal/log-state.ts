import type { TaskLog } from "../../types/index.js";

export const MAX_LIVE_LOGS = 500;

export const STAGE_TRANSITION_PREFIX = "__STAGE_TRANSITION__:";

export interface IncomingLogEntry {
  task_id: string;
  kind: TaskLog["kind"];
  message: string;
  stage?: string | null;
  agent_id?: string | null;
}

export function appendLiveLogs(
  currentLogs: TaskLog[],
  incoming: IncomingLogEntry[],
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
      stage: entry.stage ?? null,
      agent_id: entry.agent_id ?? null,
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

export function parseStageTransition(message: string): { from: string; to: string } | null {
  if (!message.startsWith(STAGE_TRANSITION_PREFIX)) return null;
  const body = message.slice(STAGE_TRANSITION_PREFIX.length);
  const arrowIdx = body.indexOf("→");
  if (arrowIdx < 0) return null;
  return {
    from: body.slice(0, arrowIdx),
    to: body.slice(arrowIdx + 1),
  };
}

// system kindのうち、ユーザーにとってノイズになるものは出さない。
// プロセス終了コード・成果物同期ステータス・after_run診断・HANDOFF JSONは非表示。
const NOISY_SYSTEM_PATTERNS: readonly RegExp[] = [
  /^Process exited with code/i,
  /^Review artifact sync:/i,
  /^\[after_run\]/i,
  /^\[HANDOFF\]/i,
];

function isInformativeSystemMessage(message: string): boolean {
  return !NOISY_SYSTEM_PATTERNS.some((pattern) => pattern.test(message));
}

function formatTerminalChunk(entry: { kind: TaskLog["kind"]; message: string }): string {
  // Stage transition markers get a distinctive full-width header and are
  // always kept — they are required for grouping logs per stage.
  const transition = parseStageTransition(entry.message);
  if (transition) {
    return `\n━━━ STAGE: ${transition.from} → ${transition.to} ━━━\n`;
  }

  const message = entry.message.trimEnd();
  if (!message) {
    return "";
  }

  if (entry.kind === "assistant") {
    return message;
  }

  // Informative system messages (approvals, PR merges, feedback responses) are
  // surfaced with a leading marker so waiting stages like human_review / done
  // no longer render as a blank segment. Noisy system chatter is still dropped.
  if (entry.kind === "system" && isInformativeSystemMessage(message)) {
    return `» ${message}`;
  }

  // Everything else — stdout, stderr, thinking, tool_call, tool_result, and
  // noisy system rows — is dropped to keep the view focused on agent output.
  return "";
}

/**
 * Friendly fallback label when a stage segment produced no displayable
 * content. Lets users distinguish "waiting for a human" from "genuinely
 * missing output".
 */
export function emptySegmentLabel(stage: string | null): string {
  switch (stage) {
    case "human_review":
      return "(Awaiting human review — no agent output in this stage)";
    case "done":
      return "(Stage completed — no agent output)";
    case "cancelled":
      return "(Cancelled — no agent output)";
    default:
      return "(empty)";
  }
}

export interface StageSegment {
  id: string;
  stage: string | null;
  /**
   * The previous stage recorded on the transition marker that opened this
   * segment, when available. Falls back to `null` for implicit segments
   * (first log before any transition, or when we had to start a segment
   * because the log's stage changed without an explicit marker). Keeping
   * this on the segment lets the UI render the full "from → to" label on
   * every segment — including the first one — instead of having to derive
   * it from adjacent segments (which fails when earlier stages produced no
   * in-stage logs at all).
   */
  fromStage: string | null;
  agentId: string | null;
  startedAt: number;
  text: string;
  entryCount: number;
}

/**
 * Group a chronological list of task_logs into contiguous per-stage segments.
 * Each stage transition marker starts a new segment. Non-transition rows are
 * formatted through `formatTerminalChunk` and concatenated as plain text so
 * the segment can be rendered as a monospace block.
 */
export function groupLogsByStage(logs: TaskLog[]): StageSegment[] {
  const segments: StageSegment[] = [];
  let current: StageSegment | null = null;

  const startSegment = (
    log: TaskLog,
    options: { stageOverride?: string | null; fromStage?: string | null } = {},
  ): StageSegment => ({
    id: `seg-${log.id}`,
    stage: options.stageOverride !== undefined ? options.stageOverride : log.stage,
    fromStage: options.fromStage ?? null,
    agentId: log.agent_id,
    startedAt: log.created_at,
    text: "",
    entryCount: 0,
  });

  for (const log of logs) {
    const transition = parseStageTransition(log.message);

    if (transition) {
      // Transition marker — close the previous segment (if any) and start a new one.
      // If the incoming transition's `to` matches the stage we are already in
      // (e.g. the DB trigger fired a duplicate marker, or the client already
      // synthesized one), merge instead of opening an empty duplicate segment.
      if (current && current.stage === transition.to) {
        // Backfill `fromStage` from the marker when the existing segment
        // lacked one (implicit segment that turned out to be the real start).
        if (current.fromStage === null) {
          current.fromStage = transition.from;
        }
        continue;
      }
      if (current) segments.push(current);
      current = startSegment(log, { stageOverride: transition.to, fromStage: transition.from });
      continue;
    }

    // Start a new segment if there is none yet, or the stage changed implicitly.
    if (!current) {
      current = startSegment(log);
    } else if (log.stage !== null && current.stage !== null && log.stage !== current.stage) {
      const previousStage = current.stage;
      segments.push(current);
      current = startSegment(log, { fromStage: previousStage });
    }

    const chunk = formatTerminalChunk({ kind: log.kind, message: log.message });
    if (chunk.length > 0) {
      current.text += current.text.endsWith("\n") || current.text.length === 0 ? chunk : `\n${chunk}`;
      if (!current.text.endsWith("\n")) current.text += "\n";
      current.entryCount += 1;
    }
  }

  if (current) segments.push(current);
  return segments;
}

/**
 * Append incoming log entries to the terminal text.
 * Automatically injects a stage header when the stage or agent changes
 * between consecutive entries, even if the server did not emit an explicit marker.
 */
export function appendTerminalText(
  currentText: string,
  incoming: IncomingLogEntry[],
  context?: { lastStage?: string | null; lastAgentId?: string | null },
): { text: string; lastStage: string | null; lastAgentId: string | null } {
  let text = currentText;
  let lastStage: string | null = context?.lastStage ?? null;
  let lastAgentId: string | null = context?.lastAgentId ?? null;

  if (incoming.length === 0) {
    return { text, lastStage, lastAgentId };
  }

  const parts: string[] = [];

  for (const entry of incoming) {
    const entryStage = entry.stage ?? null;
    const entryAgent = entry.agent_id ?? null;

    // If stage or agent changed (and the entry itself is not already a transition marker),
    // inject a synthetic header so users can tell at a glance what context produced the next lines.
    const isExplicitMarker = parseStageTransition(entry.message) !== null;
    const stageChanged = entryStage !== null && entryStage !== lastStage;
    const agentChanged = entryAgent !== null && entryAgent !== lastAgentId;

    if (!isExplicitMarker && (stageChanged || agentChanged) && (lastStage !== null || lastAgentId !== null)) {
      const stageLabel = entryStage ?? "—";
      const agentLabel = entryAgent ? entryAgent.slice(0, 8) : "—";
      parts.push(`\n── [${stageLabel}] agent:${agentLabel} ──\n`);
    }

    if (entryStage !== null) lastStage = entryStage;
    if (entryAgent !== null) lastAgentId = entryAgent;

    const chunk = formatTerminalChunk(entry);
    if (chunk.length > 0) {
      parts.push(chunk);
    }
  }

  if (parts.length === 0) {
    return { text, lastStage, lastAgentId };
  }

  const appended = parts.join("\n");
  if (!text) {
    text = `${appended}\n`;
  } else {
    const separator = text.endsWith("\n") ? "" : "\n";
    text = `${text}${separator}${appended}\n`;
  }

  return { text, lastStage, lastAgentId };
}
