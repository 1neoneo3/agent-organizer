import { memo, startTransition, useEffect, useRef, useState, useMemo, useCallback } from "react";
import { fetchTaskLogs } from "../../api/endpoints.js";
import type { TaskLog, WSEventType, Agent } from "../../types/index.js";
import { getRoleLabel } from "../agents/roles.js";
import {
  appendLiveLogs,
  countLogsByTab,
  groupLogsByStage,
  parseStageTransition,
  STAGE_TRANSITION_PREFIX,
  type StageSegment,
} from "./log-state.js";

const STAGE_STYLES: Record<string, { bg: string; border: string; text: string; label: string }> = {
  inbox: { bg: "#e0e7ff", border: "#6366f1", text: "#3730a3", label: "inbox" },
  in_progress: { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af", label: "in_progress" },
  self_review: { bg: "#fef3c7", border: "#f59e0b", text: "#92400e", label: "self_review" },
  test_generation: { bg: "#f3e8ff", border: "#a855f7", text: "#6b21a8", label: "test_gen" },
  qa_testing: { bg: "#fce7f3", border: "#ec4899", text: "#9d174d", label: "qa_testing" },
  pr_review: { bg: "#cffafe", border: "#06b6d4", text: "#155e75", label: "pr_review" },
  human_review: { bg: "#ffedd5", border: "#f97316", text: "#9a3412", label: "human_review" },
  ci_check: { bg: "#e0f2fe", border: "#0ea5e9", text: "#075985", label: "ci_check" },
  done: { bg: "#dcfce7", border: "#22c55e", text: "#166534", label: "done" },
  cancelled: { bg: "#f3f4f6", border: "#9ca3af", text: "#374151", label: "cancelled" },
};

function stageStyle(stage: string | null | undefined): { bg: string; border: string; text: string; label: string } {
  if (!stage) return { bg: "var(--bg-tertiary)", border: "var(--border-default)", text: "var(--text-secondary)", label: "—" };
  return STAGE_STYLES[stage] ?? { bg: "var(--bg-tertiary)", border: "var(--border-default)", text: "var(--text-secondary)", label: stage };
}

type TabKey = "terminal" | "all" | "output";

interface Tab {
  key: TabKey;
  label: string;
  icon: string;
}

const TABS: Tab[] = [
  { key: "terminal", label: "Terminal", icon: ">" },
  { key: "output", label: "Output", icon: "\ud83d\udcdf" },
];

type TimelineEntry = { type: "log"; data: TaskLog };

interface TerminalPanelProps {
  taskId: string;
  on: (type: WSEventType, fn: (payload: unknown) => void) => () => void;
  subscribeTask?: (taskId: string) => () => void;
  onClose: () => void;
  agents?: Agent[];
  // Parent supplies current stage/agent so live WS logs that lack metadata
  // can be tagged for display. Historical logs already have these fields
  // filled by the AFTER INSERT DB trigger.
  currentStage?: string | null;
  currentAgentId?: string | null;
  /**
   * When true, the panel fills its parent vertically (flex: 1) instead of
   * using the fixed 384px default. Use this for embedded views like the
   * tabbed task detail Activity pane, where the surrounding flex column
   * already bounds the height.
   */
  fullHeight?: boolean;
}

function classifyLog(_kind: TaskLog["kind"]): TabKey {
  return "output";
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const LIGHT_KIND_STYLES: Record<string, { bg: string; text: string; border: string; label: string; icon: string }> = {
  stdout: { bg: "#e8f5e9", text: "#1b5e20", border: "#4caf50", label: "stdout", icon: "\u25b8" },
  stderr: { bg: "#ffebee", text: "#b71c1c", border: "#f44336", label: "stderr", icon: "\u2717" },
  system: { bg: "#fff8e1", text: "#e65100", border: "#ff9800", label: "system", icon: "\u2699" },
  thinking: { bg: "#f3e5f5", text: "#4a148c", border: "#9c27b0", label: "thinking", icon: "\ud83e\udde0" },
  assistant: { bg: "#e3f2fd", text: "#0d47a1", border: "#2196f3", label: "assistant", icon: "\ud83d\udcac" },
  tool_call: { bg: "#e0f7fa", text: "#006064", border: "#00bcd4", label: "tool", icon: "\ud83d\udd27" },
  tool_result: { bg: "#e0f2f1", text: "#004d40", border: "#009688", label: "result", icon: "\ud83d\udccb" },
};

const DARK_KIND_STYLES: Record<string, { bg: string; text: string; border: string; label: string; icon: string }> = {
  stdout: { bg: "#0d1f0d", text: "#86efac", border: "#22c55e", label: "stdout", icon: "\u25b8" },
  stderr: { bg: "#1f0d0d", text: "#fca5a5", border: "#ef4444", label: "stderr", icon: "\u2717" },
  system: { bg: "#1f1a0d", text: "#fde68a", border: "#f59e0b", label: "system", icon: "\u2699" },
  thinking: { bg: "#170d1f", text: "#c4b5fd", border: "#8b5cf6", label: "thinking", icon: "\ud83e\udde0" },
  assistant: { bg: "#0d171f", text: "#93c5fd", border: "#3b82f6", label: "assistant", icon: "\ud83d\udcac" },
  tool_call: { bg: "#0d1a1f", text: "#67e8f9", border: "#06b6d4", label: "tool", icon: "\ud83d\udd27" },
  tool_result: { bg: "#0d1f1a", text: "#5eead4", border: "#14b8a6", label: "result", icon: "\ud83d\udccb" },
};

function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

const LogEntry = memo(function LogEntry({
  log,
  isDark,
  agents,
}: {
  log: TaskLog;
  isDark: boolean;
  agents: Agent[];
}) {
  const [collapsed, setCollapsed] = useState(true);
  const isLong = log.message.length > 300;

  const kindStyles = isDark ? DARK_KIND_STYLES : LIGHT_KIND_STYLES;
  const style = kindStyles[log.kind] ?? kindStyles.stdout;
  const isThinking = log.kind === "thinking";
  const isAssistant = log.kind === "assistant";

  // Stage transition markers get a distinctive full-width rendering instead of the regular log layout.
  const transition = parseStageTransition(log.message);
  if (transition) {
    const toStageStyle = stageStyle(transition.to);
    return (
      <div
        data-testid="stage-transition-marker"
        style={{
          margin: "8px 0",
          padding: "4px 8px",
          background: toStageStyle.bg,
          borderTop: `1px dashed ${toStageStyle.border}`,
          borderBottom: `1px dashed ${toStageStyle.border}`,
          color: toStageStyle.text,
          fontSize: "11px",
          fontWeight: 600,
          textAlign: "center",
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.05em",
        }}
      >
        ━━━ STAGE: {transition.from} → {transition.to} ━━━
      </div>
    );
  }

  const displayMessage = isLong && collapsed ? log.message.slice(0, 300) + "\u2026" : log.message;

  const agentName = log.agent_id ? agents.find((a) => a.id === log.agent_id)?.name ?? log.agent_id.slice(0, 8) : null;
  const currentStageStyle = stageStyle(log.stage);

  return (
    <div
      data-testid="log-entry"
      data-stage={log.stage ?? ""}
      data-agent-id={log.agent_id ?? ""}
      style={{
        background: style.bg,
        borderLeft: `2px solid ${style.border}`,
        borderRadius: "4px",
        marginBottom: "4px",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", padding: "4px 8px" }}>
        <span style={{ fontSize: "10px", color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", flexShrink: 0, marginTop: "2px", width: "52px" }}>
          {formatTime(log.created_at)}
        </span>
        <span style={{ fontSize: "10px", fontWeight: 500, flexShrink: 0, marginTop: "2px", width: "48px", textAlign: "right", color: style.text }}>
          {style.icon} {style.label}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "2px" }}>
            {log.stage && (
              <span
                data-testid="stage-badge"
                style={{
                  fontSize: "9px",
                  fontWeight: 600,
                  padding: "1px 6px",
                  borderRadius: "3px",
                  background: currentStageStyle.bg,
                  color: currentStageStyle.text,
                  border: `1px solid ${currentStageStyle.border}`,
                  lineHeight: 1.4,
                }}
              >
                {currentStageStyle.label}
              </span>
            )}
            {agentName && (
              <span
                data-testid="agent-badge"
                style={{
                  fontSize: "9px",
                  fontWeight: 500,
                  padding: "1px 6px",
                  borderRadius: "3px",
                  background: "var(--bg-tertiary)",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border-subtle)",
                  lineHeight: 1.4,
                }}
              >
                @{agentName}
              </span>
            )}
          </div>
          {isThinking ? (
            <div style={{ fontSize: "12px", color: style.text, fontStyle: "italic" }}>
              <span style={{ whiteSpace: "pre-wrap" }}>{displayMessage}</span>
            </div>
          ) : isAssistant ? (
            <div style={{ fontSize: "12px", color: style.text, fontWeight: 500 }}>
              <span style={{ whiteSpace: "pre-wrap" }}>{displayMessage}</span>
            </div>
          ) : (
            <span style={{ fontSize: "12px", color: style.text, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>
              {displayMessage}
            </span>
          )}
          {isLong && (
            <button
              onClick={() => setCollapsed((v) => !v)}
              style={{
                fontSize: "10px",
                color: "var(--accent-primary)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                marginTop: "2px",
                display: "block",
              }}
            >
              {collapsed ? "\u25bc Show more" : "\u25b2 Show less"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

const PAUSE_SCROLL_THRESHOLD = 50;

function TerminalView({
  taskId,
  on,
  currentStage,
  currentAgentId,
  agents,
}: {
  taskId: string;
  on: (type: WSEventType, fn: (payload: unknown) => void) => () => void;
  currentStage: string | null;
  currentAgentId: string | null;
  agents: Agent[];
}) {
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [follow, setFollow] = useState(true);
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});
  const containerRef = useRef<HTMLDivElement>(null);

  const doFetch = useCallback(async () => {
    try {
      // Fetch up to 300 rows. Server truncates each message at 4KB to keep
      // the response payload bounded (some rows contain raw tool-result JSON
      // blobs tens of KB each, which would otherwise freeze the browser when
      // rendering the Activity panel). task_logs carries stage/agent_id via
      // the AFTER INSERT trigger, so grouping is done on the client.
      const rows = await fetchTaskLogs(taskId, 300);
      // Server returns rows in reverse chronological order; flip to chronological.
      const chronological = [...rows].reverse();
      setLogs(chronological);
    } catch {
      // ignore fetch errors
    }
  }, [taskId]);

  useEffect(() => {
    doFetch();
  }, [doFetch]);

  // Stage transitions are recorded by a DB trigger but are NOT broadcast
  // over WebSocket (the trigger has no access to the hub). Without this
  // effect the Activity tab would stay pinned to the stage that was
  // active when the modal opened — new segments only appeared after a
  // re-fetch (page reload or tab switch). Detect currentStage changes
  // here and append a synthetic transition marker so `groupLogsByStage`
  // opens a fresh segment immediately. The real DB row still exists and
  // will replace the synthetic one on the next mount-driven fetch.
  const prevStageRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevStageRef.current;
    const next = currentStage ?? null;
    // Skip the very first effect run (prev === undefined) so we do not
    // emit a bogus `null → refinement` marker when the component mounts
    // on an already-advanced task.
    if (prev !== undefined && prev !== next) {
      const expectedMessage = `${STAGE_TRANSITION_PREFIX}${prev ?? "null"}→${next ?? "null"}`;
      setLogs((current) => {
        // Dedup guard: if a matching transition marker is already sitting at
        // the tail of logs — which happens when a fetch/WS replay brought in
        // the DB-trigger-inserted row before our synthetic write settled —
        // skip the synthetic insert so groupLogsByStage does not render two
        // consecutive segments for the same `from → to` event.
        for (let i = current.length - 1; i >= 0 && i >= current.length - 10; i--) {
          const log = current[i];
          if (!log) continue;
          if (log.message === expectedMessage) {
            return current;
          }
          // Stop scanning once we pass the likely window for this transition.
          if (log.message.startsWith(STAGE_TRANSITION_PREFIX)) break;
        }
        return appendLiveLogs(current, [{
          task_id: taskId,
          kind: "system",
          message: expectedMessage,
          stage: next,
          agent_id: currentAgentId ?? null,
        }]);
      });
    }
    prevStageRef.current = next;
  }, [currentStage, currentAgentId, taskId]);

  useEffect(() => {
    return on("cli_output", (payload) => {
      const data = payload as
        | { task_id: string; kind: string; message: string; stage?: string | null; agent_id?: string | null }
        | Array<{ task_id: string; kind: string; message: string; stage?: string | null; agent_id?: string | null }>;
      const items = Array.isArray(data) ? data : [data];
      const relevant = items
        .filter((entry) => entry.task_id === taskId)
        .map((entry) => ({
          task_id: entry.task_id,
          kind: entry.kind as TaskLog["kind"],
          message: entry.message,
          stage: entry.stage ?? currentStage,
          agent_id: entry.agent_id ?? currentAgentId,
        }));

      if (relevant.length === 0) {
        return;
      }

      // Update eagerly (no startTransition). Live log streaming is the
      // user-visible point of the Terminal tab — any deferral makes the
      // output feel laggy even though the server is delivering chunks
      // sub-100ms after they appear. React 18 batches multiple setLogs
      // calls inside the same macrotask automatically, so we still get
      // the benefits of batching without the concurrent-mode defer that
      // startTransition adds on top.
      setLogs((prev) => appendLiveLogs(prev, relevant));
    });
  }, [taskId, on, currentStage, currentAgentId]);

  const segments = useMemo(() => groupLogsByStage(logs), [logs]);

  // Auto-scroll the latest segment into view when follow mode is active.
  useEffect(() => {
    if (follow && containerRef.current) {
      requestAnimationFrame(() => {
        containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
      });
    }
  }, [segments, follow]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom > PAUSE_SCROLL_THRESHOLD) {
      setFollow(false);
    }
  };

  const resumeFollow = () => {
    setFollow(true);
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: "smooth" });
  };

  const toggleSegment = useCallback((id: string, defaultOpen: boolean) => {
    setExpandedOverride((prev) => {
      const currentlyOpen = prev[id] ?? defaultOpen;
      return { ...prev, [id]: !currentlyOpen };
    });
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{ flex: "1 1 0", overflowY: "auto", background: "var(--terminal-bg)", padding: "8px" }}
      >
        {segments.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--text-tertiary)",
              fontSize: "12px",
            }}
          >
            Waiting for output...
          </div>
        ) : (
          segments.map((segment, index) => {
            const isLast = index === segments.length - 1;
            const defaultOpen = isLast;
            const isOpen = expandedOverride[segment.id] ?? defaultOpen;
            return (
              <StageSegmentBlock
                key={segment.id}
                segment={segment}
                isOpen={isOpen}
                onToggle={() => toggleSegment(segment.id, defaultOpen)}
                agents={agents}
                previousStage={index > 0 ? segments[index - 1]?.stage ?? null : null}
              />
            );
          })
        )}
      </div>
      {!follow && (
        <button
          onClick={resumeFollow}
          style={{
            position: "absolute",
            bottom: "8px",
            right: "16px",
            fontSize: "10px",
            color: "var(--terminal-text-dim)",
            background: "var(--terminal-header-bg)",
            border: "1px solid var(--border-default)",
            borderRadius: "4px",
            padding: "2px 8px",
            cursor: "pointer",
          }}
        >
          {"\u2193"} Follow
        </button>
      )}
    </div>
  );
}

const StageSegmentBlock = memo(function StageSegmentBlock({
  segment,
  isOpen,
  onToggle,
  agents,
  previousStage,
}: {
  segment: StageSegment;
  isOpen: boolean;
  onToggle: () => void;
  agents: Agent[];
  previousStage: string | null;
}) {
  const style = stageStyle(segment.stage);
  const agent = segment.agentId ? agents.find((a) => a.id === segment.agentId) ?? null : null;
  const agentName = agent ? agent.name : segment.agentId ? segment.agentId.slice(0, 8) : null;
  const roleLabel = agent?.role ? getRoleLabel(agent.role) ?? agent.role : null;
  const modelLabel = agent?.cli_model ?? null;
  const providerLabel = agent?.cli_provider ?? null;
  // Prefer the transition marker's own `from` (captured as segment.fromStage)
  // because it records the real predecessor even when earlier stages produced
  // no displayable logs. Fall back to the adjacent segment's stage for
  // implicit segments where no marker was present.
  const effectiveFromStage = segment.fromStage ?? previousStage;
  const transitionLabel = effectiveFromStage !== null && effectiveFromStage !== segment.stage
    ? `${effectiveFromStage} → ${segment.stage ?? "—"}`
    : segment.stage ?? "—";
  const startedAtLabel = new Date(segment.startedAt).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const chipStyle = {
    fontSize: "10px",
    fontWeight: 500,
    padding: "1px 6px",
    borderRadius: "3px",
    background: "rgba(255,255,255,0.35)",
    lineHeight: 1.4,
  } as const;

  return (
    <div
      data-testid="stage-segment"
      data-stage={segment.stage ?? ""}
      data-open={isOpen ? "true" : "false"}
      style={{
        marginBottom: "8px",
        border: `1px solid ${style.border}`,
        borderRadius: "6px",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        data-testid="stage-segment-toggle"
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          width: "100%",
          padding: "6px 10px",
          background: style.bg,
          color: style.text,
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          fontWeight: 600,
          textAlign: "left",
          gap: "12px",
        }}
      >
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: "10px" }}>{isOpen ? "▼" : "▶"}</span>
          <span>━━━ STAGE: {transitionLabel} ━━━</span>
          {agentName && (
            <span data-testid="segment-agent-chip" style={chipStyle}>
              @{agentName}
            </span>
          )}
          {roleLabel && (
            <span data-testid="segment-role-chip" style={chipStyle}>
              {roleLabel}
            </span>
          )}
          {(providerLabel || modelLabel) && (
            <span data-testid="segment-model-chip" style={chipStyle}>
              {providerLabel ? `${providerLabel}` : ""}
              {providerLabel && modelLabel ? " / " : ""}
              {modelLabel ?? ""}
            </span>
          )}
        </span>
        <span style={{ fontSize: "10px", fontWeight: 400, opacity: 0.8, flexShrink: 0, whiteSpace: "nowrap" }}>
          {segment.entryCount} entries · {startedAtLabel}
        </span>
      </button>
      {isOpen && (
        <pre
          data-testid="stage-segment-body"
          style={{
            fontSize: "12px",
            lineHeight: 1.6,
            color: "var(--terminal-text)",
            background: "var(--terminal-bg)",
            padding: "10px 12px",
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
            // No inner maxHeight: the outer terminal container already
            // provides a bounded scroll region (see containerRef scroller),
            // so constraining the segment body here only creates dead
            // whitespace below when the text fits within 500px while the
            // outer pane is much taller.
          }}
        >
          {segment.text || "(empty)"}
        </pre>
      )}
    </div>
  );
});

export function TerminalPanel({
  taskId,
  on,
  subscribeTask,
  onClose,
  agents = [],
  currentStage = null,
  currentAgentId = null,
  fullHeight = false,
}: TerminalPanelProps) {
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("terminal");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isDark = useIsDark();
  // Keep a ref in sync so the WS handler closure always sees the latest values.
  const currentStageRef = useRef<string | null>(currentStage);
  const currentAgentIdRef = useRef<string | null>(currentAgentId);
  useEffect(() => {
    currentStageRef.current = currentStage;
    currentAgentIdRef.current = currentAgentId;
  }, [currentStage, currentAgentId]);

  const logsFetched = useRef(false);
  useEffect(() => {
    if (activeTab === "terminal" || logsFetched.current) return;
    logsFetched.current = true;
    fetchTaskLogs(taskId, 50).then((data) => {
      startTransition(() => {
        setLogs(data.reverse());
      });
    });
  }, [taskId, activeTab]);

  useEffect(() => {
    if (!subscribeTask) {
      return;
    }

    return subscribeTask(taskId);
  }, [subscribeTask, taskId]);

  useEffect(() => {
    return on("cli_output", (payload) => {
      const data = payload as
        | { task_id: string; kind: string; message: string; stage?: string | null; agent_id?: string | null }
        | Array<{ task_id: string; kind: string; message: string; stage?: string | null; agent_id?: string | null }>;
      const items = Array.isArray(data) ? data : [data];
      const relevant = items
        .filter((d) => d.task_id === taskId)
        .map((d) => ({
          task_id: d.task_id,
          kind: d.kind as TaskLog["kind"],
          message: d.message,
          // Fall back to parent-supplied current stage/agent when the WS payload
          // did not include them. Historical records get these from the DB trigger.
          stage: d.stage ?? currentStageRef.current,
          agent_id: d.agent_id ?? currentAgentIdRef.current,
        }));
      if (relevant.length > 0) {
        // See the matching note in TerminalView above — live streaming
        // should not be deferred through startTransition. React 18
        // still batches synchronously-enqueued updates.
        setLogs((prev) => appendLiveLogs(prev, relevant));
      }
    });
  }, [taskId, on]);

  const timeline = useMemo((): TimelineEntry[] => {
    if (activeTab === "terminal") return [];

    const entries: TimelineEntry[] = [];

    for (const log of logs) {
      const tab = classifyLog(log.kind);
      if (activeTab === tab) {
        entries.push({ type: "log", data: log });
      }
    }

    return entries;
  }, [logs, activeTab]);

  useEffect(() => {
    if (activeTab !== "terminal" && autoScroll && scrollRef.current) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }
  }, [timeline, autoScroll, activeTab]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const counts = useMemo(() => {
    return countLogsByTab(logs);
  }, [logs]);

  const isTerminalTab = activeTab === "terminal";

  return (
    <div style={{
      background: "var(--terminal-header-bg)",
      border: "1px solid var(--border-default)",
      borderRadius: "8px",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      // When embedded in a flex column (e.g. the Activity tab) we fill the
      // parent; otherwise fall back to the legacy fixed height used by the
      // standalone log modal.
      ...(fullHeight ? { flex: 1, minHeight: 0, width: "100%" } : { height: "384px" }),
      position: "relative",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "6px 12px",
        background: "var(--terminal-header-bg)",
        borderBottom: "1px solid var(--border-default)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: "4px 10px",
                fontSize: "11px",
                fontWeight: 500,
                borderRadius: "4px",
                border: "none",
                cursor: "pointer",
                transition: "background 0.15s",
                background: activeTab === tab.key ? "var(--bg-hover)" : "transparent",
                color: activeTab === tab.key ? "var(--text-primary)" : "var(--terminal-text-dim)",
              }}
            >
              {tab.icon} {tab.label}
              {tab.key !== "terminal" && counts[tab.key] > 0 && (
                <span style={{ marginLeft: "4px", fontSize: "9px", opacity: activeTab === tab.key ? 0.7 : 0.4 }}>
                  {counts[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "10px", color: "var(--terminal-text-dim)", fontFamily: "var(--font-mono)" }}>
            {taskId.slice(0, 8)}
          </span>
          {!isTerminalTab && !autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
              }}
              style={{ fontSize: "10px", color: "var(--terminal-text-dim)", background: "none", border: "none", cursor: "pointer" }}
            >
              {"\u2193"} Bottom
            </button>
          )}
          <button
            onClick={onClose}
            style={{ color: "var(--terminal-text-dim)", background: "none", border: "none", cursor: "pointer", fontSize: "14px" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--terminal-text-dim)"; }}
          >
            {"\u2715"}
          </button>
        </div>
      </div>

      {/* Content */}
      {isTerminalTab ? (
        <TerminalView
          taskId={taskId}
          on={on}
          currentStage={currentStage}
          currentAgentId={currentAgentId}
          agents={agents}
        />
      ) : (
        <div ref={scrollRef} onScroll={handleScroll} style={{ flex: "1 1 0", minHeight: 0, overflowY: "auto", padding: "8px", paddingBottom: "24px", background: "var(--terminal-bg)" }}>
          {timeline.length === 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--terminal-text-dim)", fontSize: "12px" }}>
              No activity yet
            </div>
          )}
          {timeline.map((entry) => (
            <LogEntry key={`log-${entry.data.id}`} log={entry.data} isDark={isDark} agents={agents} />
          ))}
        </div>
      )}
    </div>
  );
}
