import { startTransition, useEffect, useRef, useState, useMemo, useCallback } from "react";
import { fetchTaskLogs, fetchTerminal } from "../../api/endpoints.js";
import type { TaskLog, WSEventType } from "../../types/index.js";
import { appendLiveLogs, appendTerminalText, countLogsByTab } from "./log-state.js";

type TabKey = "terminal" | "all" | "output";

interface Tab {
  key: TabKey;
  label: string;
  icon: string;
}

const TABS: Tab[] = [
  { key: "terminal", label: "Terminal", icon: ">" },
  { key: "all", label: "All", icon: "\u26a1" },
  { key: "output", label: "Output", icon: "\ud83d\udcdf" },
];

type TimelineEntry = { type: "log"; data: TaskLog };

interface TerminalPanelProps {
  taskId: string;
  on: (type: WSEventType, fn: (payload: unknown) => void) => () => void;
  subscribeTask?: (taskId: string) => () => void;
  onClose: () => void;
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

function LogEntry({ log, isDark }: { log: TaskLog; isDark: boolean }) {
  const [collapsed, setCollapsed] = useState(true);
  const isLong = log.message.length > 300;

  const kindStyles = isDark ? DARK_KIND_STYLES : LIGHT_KIND_STYLES;
  const style = kindStyles[log.kind] ?? kindStyles.stdout;
  const isThinking = log.kind === "thinking";
  const isAssistant = log.kind === "assistant";

  const displayMessage = isLong && collapsed ? log.message.slice(0, 300) + "\u2026" : log.message;

  return (
    <div style={{
      background: style.bg,
      borderLeft: `2px solid ${style.border}`,
      borderRadius: "4px",
      marginBottom: "4px",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", padding: "4px 8px" }}>
        <span style={{ fontSize: "10px", color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", flexShrink: 0, marginTop: "2px", width: "52px" }}>
          {formatTime(log.created_at)}
        </span>
        <span style={{ fontSize: "10px", fontWeight: 500, flexShrink: 0, marginTop: "2px", width: "48px", textAlign: "right", color: style.text }}>
          {style.icon} {style.label}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
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
}

const PAUSE_SCROLL_THRESHOLD = 50;

function TerminalView({
  taskId,
  on,
}: {
  taskId: string;
  on: (type: WSEventType, fn: (payload: unknown) => void) => () => void;
}) {
  const [text, setText] = useState("");
  const [follow, setFollow] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const doFetch = useCallback(async () => {
    try {
      const resp = await fetchTerminal(taskId);
      setText(resp.text || "");
    } catch {
      // ignore fetch errors
    }
  }, [taskId]);

  useEffect(() => {
    doFetch();
  }, [doFetch]);

  useEffect(() => {
    return on("cli_output", (payload) => {
      const data = payload as
        | { task_id: string; kind: string; message: string }
        | Array<{ task_id: string; kind: string; message: string }>;
      const items = Array.isArray(data) ? data : [data];
      const relevant = items.filter((entry) => entry.task_id === taskId) as Array<{
        task_id: string;
        kind: TaskLog["kind"];
        message: string;
      }>;

      if (relevant.length === 0) {
        return;
      }

      startTransition(() => {
        setText((current) => appendTerminalText(current, relevant));
      });
    });
  }, [taskId, on]);

  useEffect(() => {
    if (follow && containerRef.current) {
      requestAnimationFrame(() => {
        containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
      });
    }
  }, [text, follow]);

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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{ flex: "1 1 0", overflowY: "auto", background: "var(--terminal-bg)" }}
      >
        {text ? (
          <pre
            ref={preRef}
            style={{
              fontSize: "12px",
              lineHeight: "1.6",
              color: "var(--terminal-text)",
              padding: "12px",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: 0,
              paddingBottom: "24px",
            }}
          >
            {text}
          </pre>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-tertiary)", fontSize: "12px" }}>
            Waiting for output...
          </div>
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

export function TerminalPanel({ taskId, on, subscribeTask, onClose }: TerminalPanelProps) {
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("terminal");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isDark = useIsDark();

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
        | { task_id: string; kind: string; message: string }
        | Array<{ task_id: string; kind: string; message: string }>;
      const items = Array.isArray(data) ? data : [data];
      const relevant = items.filter((d) => d.task_id === taskId) as Array<{ task_id: string; kind: TaskLog["kind"]; message: string }>;
      if (relevant.length > 0) {
        startTransition(() => {
          setLogs((prev) => appendLiveLogs(prev, relevant));
        });
      }
    });
  }, [taskId, on]);

  const timeline = useMemo((): TimelineEntry[] => {
    if (activeTab === "terminal") return [];

    const entries: TimelineEntry[] = [];

    for (const log of logs) {
      const tab = classifyLog(log.kind);
      if (activeTab === "all" || activeTab === tab) {
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
      height: "384px",
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
        <TerminalView taskId={taskId} on={on} />
      ) : (
        <div ref={scrollRef} onScroll={handleScroll} style={{ flex: "1 1 0", minHeight: 0, overflowY: "auto", padding: "8px", paddingBottom: "24px", background: "var(--terminal-bg)" }}>
          {timeline.length === 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--terminal-text-dim)", fontSize: "12px" }}>
              No activity yet
            </div>
          )}
          {timeline.map((entry) => (
            <LogEntry key={`log-${entry.data.id}`} log={entry.data} isDark={isDark} />
          ))}
        </div>
      )}
    </div>
  );
}
