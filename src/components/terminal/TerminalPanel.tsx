import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { fetchTaskLogs, fetchTerminal } from "../../api/endpoints.js";
import type { TaskLog, WSEventType } from "../../types/index.js";

type TabKey = "terminal" | "all" | "output";

interface Tab {
  key: TabKey;
  label: string;
  icon: string;
}

const TABS: Tab[] = [
  { key: "terminal", label: "Terminal", icon: ">" },
  { key: "all", label: "All", icon: "⚡" },
  { key: "output", label: "Output", icon: "📟" },
];

type TimelineEntry = { type: "log"; data: TaskLog };

interface TerminalPanelProps {
  taskId: string;
  on: (type: WSEventType, fn: (payload: unknown) => void) => () => void;
  onClose: () => void;
}

function classifyLog(_kind: TaskLog["kind"]): TabKey {
  return "output";
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function LogEntry({ log }: { log: TaskLog }) {
  const [collapsed, setCollapsed] = useState(true);
  const isLong = log.message.length > 300;

  const kindStyles: Record<string, { bg: string; text: string; border: string; label: string; icon: string }> = {
    stdout: {
      bg: "bg-emerald-50 dark:bg-emerald-50",
      text: "text-emerald-900 dark:text-emerald-900",
      border: "border-emerald-400 dark:border-emerald-400",
      label: "stdout",
      icon: "▸",
    },
    stderr: {
      bg: "bg-red-50 dark:bg-red-50",
      text: "text-red-800 dark:text-red-800",
      border: "border-red-400 dark:border-red-400",
      label: "stderr",
      icon: "✗",
    },
    system: {
      bg: "bg-amber-50 dark:bg-amber-50",
      text: "text-amber-900 dark:text-amber-900",
      border: "border-amber-400 dark:border-amber-400",
      label: "system",
      icon: "⚙",
    },
    thinking: {
      bg: "bg-violet-50 dark:bg-violet-50",
      text: "text-violet-900 dark:text-violet-900",
      border: "border-violet-400 dark:border-violet-400",
      label: "thinking",
      icon: "🧠",
    },
    assistant: {
      bg: "bg-sky-50 dark:bg-sky-50",
      text: "text-sky-900 dark:text-sky-900",
      border: "border-sky-400 dark:border-sky-400",
      label: "assistant",
      icon: "💬",
    },
    tool_call: {
      bg: "bg-cyan-50 dark:bg-cyan-50",
      text: "text-cyan-900 dark:text-cyan-900",
      border: "border-cyan-400 dark:border-cyan-400",
      label: "tool",
      icon: "🔧",
    },
    tool_result: {
      bg: "bg-teal-50 dark:bg-teal-50",
      text: "text-teal-900 dark:text-teal-900",
      border: "border-teal-400 dark:border-teal-400",
      label: "result",
      icon: "📋",
    },
  };

  const style = kindStyles[log.kind] ?? kindStyles.stdout;
  const isThinking = log.kind === "thinking";
  const isAssistant = log.kind === "assistant";

  const displayMessage = isLong && collapsed ? log.message.slice(0, 300) + "…" : log.message;

  return (
    <div className={`${style.bg} border-l-3 ${style.border} rounded-xl mb-1.5 shadow-sm`}>
      <div className="flex items-start gap-2 px-2 py-1">
        <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono shrink-0 mt-0.5 w-14">
          {formatTime(log.created_at)}
        </span>
        <span className="text-[10px] font-medium shrink-0 mt-0.5 w-12 text-right text-gray-600 dark:text-gray-600">
          {style.icon} {style.label}
        </span>
        <div className="flex-1 min-w-0">
          {isThinking ? (
            <div className={`text-xs ${style.text} italic`}>
              <span className="whitespace-pre-wrap">{displayMessage}</span>
            </div>
          ) : isAssistant ? (
            <div className={`text-xs ${style.text} font-medium`}>
              <span className="whitespace-pre-wrap">{displayMessage}</span>
            </div>
          ) : (
            <span className={`text-xs ${style.text} whitespace-pre-wrap font-mono`}>
              {displayMessage}
            </span>
          )}
          {isLong && (
            <button
              onClick={() => setCollapsed((v) => !v)}
              className="text-[10px] text-blue-500 hover:text-blue-400 mt-0.5 block"
            >
              {collapsed ? "▼ Show more" : "▲ Show less"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const POLL_INTERVAL = 1500;
const PAUSE_SCROLL_THRESHOLD = 50;

function TerminalView({ taskId }: { taskId: string }) {
  const [text, setText] = useState("");
  const [follow, setFollow] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doFetch = useCallback(async () => {
    try {
      const resp = await fetchTerminal(taskId);
      setText(resp.text || "");
    } catch {
      // ignore fetch errors
    }
  }, [taskId]);

  // Start/stop polling based on visibility
  useEffect(() => {
    doFetch();

    const startPolling = () => {
      if (pollRef.current) return;
      pollRef.current = setInterval(doFetch, POLL_INTERVAL);
    };

    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    startPolling();

    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        doFetch();
        startPolling();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [doFetch]);

  // Auto-scroll when follow is on and text changes
  useEffect(() => {
    if (follow && containerRef.current) {
      containerRef.current.scrollTo({ top: containerRef.current.scrollHeight });
    }
  }, [text, follow]);

  // Detect manual scroll → pause follow
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
    <div className="flex flex-col h-full">
      {/* Terminal content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-sky-50/80 dark:bg-sky-50/80"
      >
        {text ? (
          <pre
            ref={preRef}
            className="text-xs leading-relaxed text-gray-900 dark:text-gray-900 p-3 font-mono whitespace-pre-wrap break-words m-0"
          >
            {text}
          </pre>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400 text-xs">
            Waiting for output...
          </div>
        )}
      </div>
    </div>
  );
}

export function TerminalPanel({ taskId, on, onClose }: TerminalPanelProps) {
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("terminal");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load initial logs (for non-terminal tabs)
  useEffect(() => {
    fetchTaskLogs(taskId).then((data) => {
      setLogs(data.reverse());
    });
  }, [taskId]);

  // WebSocket: CLI output streaming
  useEffect(() => {
    return on("cli_output", (payload) => {
      const data = payload as
        | { task_id: string; kind: string; message: string }
        | Array<{ task_id: string; kind: string; message: string }>;
      const items = Array.isArray(data) ? data : [data];
      const relevant = items.filter((d) => d.task_id === taskId);
      if (relevant.length > 0) {
        setLogs((prev) => [
          ...prev,
          ...relevant.map((d, i) => ({
            id: Date.now() + i,
            task_id: d.task_id,
            kind: d.kind as TaskLog["kind"],
            message: d.message,
            created_at: Date.now(),
          })),
        ]);
      }
    });
  }, [taskId, on]);

  // Build filtered timeline (for non-terminal tabs)
  const timeline = useMemo((): TimelineEntry[] => {
    if (activeTab === "terminal") return [];

    const entries: TimelineEntry[] = [];

    for (const log of logs) {
      const tab = classifyLog(log.kind);
      if (activeTab === "all" || activeTab === tab) {
        entries.push({ type: "log", data: log });
      }
    }

    entries.sort((a, b) => a.data.created_at - b.data.created_at);

    return entries;
  }, [logs, activeTab]);

  // Auto-scroll (non-terminal tabs)
  useEffect(() => {
    if (activeTab !== "terminal" && autoScroll && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [timeline, autoScroll, activeTab]);

  // Detect manual scroll (non-terminal tabs)
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  // Tab counts
  const counts = useMemo(() => {
    const c = { terminal: 0, all: 0, output: 0 };
    for (const log of logs) {
      const tab = classifyLog(log.kind);
      c[tab]++;
      c.all++;
    }
    return c;
  }, [logs]);

  const isTerminalTab = activeTab === "terminal";

  return (
    <div className="bg-sky-50 dark:bg-sky-50 border-2 border-sky-400 dark:border-sky-400 rounded-2xl overflow-hidden flex flex-col h-96 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-sky-600 dark:bg-sky-600 border-b-2 border-sky-700 dark:border-sky-700">
        <div className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-2 py-0.5 text-[11px] rounded-lg transition-colors ${
                activeTab === tab.key
                  ? tab.key === "terminal"
                    ? "bg-sky-800 text-white font-mono font-medium"
                    : "bg-sky-800 text-white font-medium shadow-sm"
                  : "text-white/70 hover:bg-sky-500 hover:text-white"
              }`}
            >
              {tab.icon} {tab.label}
              {tab.key !== "terminal" && counts[tab.key] > 0 && (
                <span className={`ml-1 text-[9px] ${activeTab === tab.key ? "opacity-75" : "opacity-50"}`}>
                  {counts[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white font-mono">
            {taskId.slice(0, 8)}
          </span>
          {!isTerminalTab && !autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
              }}
              className="text-[10px] text-white/70 hover:text-white"
            >
              ↓ Bottom
            </button>
          )}
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white text-sm"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Content */}
      {isTerminalTab ? (
        <TerminalView taskId={taskId} />
      ) : (
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-2 bg-sky-50/50 dark:bg-sky-50/50">
          {timeline.length === 0 && (
            <div className="flex items-center justify-center h-full text-gray-400 text-xs">
              No activity yet
            </div>
          )}
          {timeline.map((entry) => (
            <LogEntry key={`log-${entry.data.id}`} log={entry.data} />
          ))}
        </div>
      )}
    </div>
  );
}
