import { useEffect, useRef, useState, useMemo } from "react";
import { fetchTaskLogs, fetchMessages } from "../../api/endpoints.js";
import type { TaskLog, Message, WSEventType } from "../../types/index.js";

type TabKey = "all" | "output" | "thinking" | "messages";

interface Tab {
  key: TabKey;
  label: string;
  icon: string;
}

const TABS: Tab[] = [
  { key: "all", label: "All", icon: "⚡" },
  { key: "output", label: "Output", icon: "📟" },
  { key: "thinking", label: "Thinking", icon: "🧠" },
  { key: "messages", label: "Messages", icon: "💬" },
];

type TimelineEntry =
  | { type: "log"; data: TaskLog }
  | { type: "message"; data: Message };

interface TerminalPanelProps {
  taskId: string;
  on: (type: WSEventType, fn: (payload: unknown) => void) => () => void;
  onClose: () => void;
}

function classifyLog(kind: TaskLog["kind"]): TabKey {
  switch (kind) {
    case "thinking":
      return "thinking";
    case "assistant":
      return "messages";
    case "tool_call":
    case "tool_result":
      return "output";
    default:
      return "output";
  }
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
      bg: "bg-gray-50 dark:bg-gray-900/50",
      text: "text-green-700 dark:text-green-300",
      border: "border-green-500/30",
      label: "stdout",
      icon: "▸",
    },
    stderr: {
      bg: "bg-red-50/50 dark:bg-red-900/10",
      text: "text-red-600 dark:text-red-400",
      border: "border-red-500/30",
      label: "stderr",
      icon: "✗",
    },
    system: {
      bg: "bg-yellow-50/50 dark:bg-yellow-900/10",
      text: "text-yellow-700 dark:text-yellow-400",
      border: "border-yellow-500/30",
      label: "system",
      icon: "⚙",
    },
    thinking: {
      bg: "bg-purple-50/50 dark:bg-purple-900/15",
      text: "text-purple-700 dark:text-purple-300",
      border: "border-purple-500/40",
      label: "thinking",
      icon: "🧠",
    },
    assistant: {
      bg: "bg-blue-50/50 dark:bg-blue-900/15",
      text: "text-blue-800 dark:text-blue-200",
      border: "border-blue-500/40",
      label: "assistant",
      icon: "💬",
    },
    tool_call: {
      bg: "bg-cyan-50/50 dark:bg-cyan-900/10",
      text: "text-cyan-700 dark:text-cyan-300",
      border: "border-cyan-500/30",
      label: "tool",
      icon: "🔧",
    },
    tool_result: {
      bg: "bg-teal-50/50 dark:bg-teal-900/10",
      text: "text-teal-700 dark:text-teal-300",
      border: "border-teal-500/30",
      label: "result",
      icon: "📋",
    },
  };

  const style = kindStyles[log.kind] ?? kindStyles.stdout;
  const isThinking = log.kind === "thinking";
  const isAssistant = log.kind === "assistant";

  const displayMessage = isLong && collapsed ? log.message.slice(0, 300) + "…" : log.message;

  return (
    <div className={`${style.bg} border-l-2 ${style.border} rounded-r-md mb-1`}>
      <div className="flex items-start gap-2 px-2 py-1">
        <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono shrink-0 mt-0.5 w-14">
          {formatTime(log.created_at)}
        </span>
        <span className="text-[10px] font-medium shrink-0 mt-0.5 w-12 text-right text-gray-500 dark:text-gray-400">
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

function MessageEntry({ message, agents }: { message: Message; agents?: undefined }) {
  const isUser = message.sender_type === "user";
  const isSystem = message.sender_type === "system";

  return (
    <div className={`mb-1 flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-1.5 text-xs ${
          isUser
            ? "bg-blue-600 text-white"
            : isSystem
              ? "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300 border border-yellow-300 dark:border-yellow-700"
              : "bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-600"
        }`}
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="font-medium text-[10px] opacity-75">
            {message.sender_type === "agent" ? "🤖 Agent" : message.sender_type === "user" ? "👤 User" : "⚙ System"}
          </span>
          <span className="text-[10px] opacity-50">
            {formatTime(message.created_at)}
          </span>
        </div>
        <div className="whitespace-pre-wrap">{message.content}</div>
      </div>
    </div>
  );
}

export function TerminalPanel({ taskId, on, onClose }: TerminalPanelProps) {
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load initial logs + messages
  useEffect(() => {
    fetchTaskLogs(taskId).then((data) => {
      setLogs(data.reverse());
    });
    fetchMessages(taskId).then((data) => {
      setMessages(data);
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

  // WebSocket: New messages
  useEffect(() => {
    return on("message_new", (payload) => {
      const msg = payload as Message;
      if (msg.task_id === taskId) {
        setMessages((prev) => [...prev, msg]);
      }
    });
  }, [taskId, on]);

  // Build filtered timeline
  const timeline = useMemo((): TimelineEntry[] => {
    const entries: TimelineEntry[] = [];

    for (const log of logs) {
      const tab = classifyLog(log.kind);
      if (activeTab === "all" || activeTab === tab) {
        entries.push({ type: "log", data: log });
      }
    }

    if (activeTab === "all" || activeTab === "messages") {
      for (const msg of messages) {
        entries.push({ type: "message", data: msg });
      }
    }

    entries.sort((a, b) => {
      const tsA = a.type === "log" ? a.data.created_at : a.data.created_at;
      const tsB = b.type === "log" ? b.data.created_at : b.data.created_at;
      return tsA - tsB;
    });

    return entries;
  }, [logs, messages, activeTab]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [timeline, autoScroll]);

  // Detect manual scroll
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  // Tab counts
  const counts = useMemo(() => {
    const c = { all: 0, output: 0, thinking: 0, messages: messages.length };
    for (const log of logs) {
      const tab = classifyLog(log.kind);
      c[tab]++;
      c.all++;
    }
    c.all += messages.length;
    return c;
  }, [logs, messages]);

  return (
    <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden flex flex-col h-96">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                activeTab === tab.key
                  ? "bg-blue-600 text-white font-medium"
                  : "text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {tab.icon} {tab.label}
              {counts[tab.key] > 0 && (
                <span className={`ml-1 text-[9px] ${activeTab === tab.key ? "opacity-75" : "opacity-50"}`}>
                  {counts[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">
            {taskId.slice(0, 8)}
          </span>
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
              }}
              className="text-[10px] text-blue-500 hover:text-blue-400"
            >
              ↓ Bottom
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-sm"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Timeline */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-2">
        {timeline.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500 text-xs">
            No activity yet
          </div>
        )}
        {timeline.map((entry, i) =>
          entry.type === "log" ? (
            <LogEntry key={`log-${entry.data.id}`} log={entry.data} />
          ) : (
            <MessageEntry key={`msg-${entry.data.id}`} message={entry.data} />
          )
        )}
      </div>
    </div>
  );
}
