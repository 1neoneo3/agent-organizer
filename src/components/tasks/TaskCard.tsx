import { useState, useRef, useEffect } from "react";
import { getRoleLabel, getRoleColorClass } from "../../components/agents/roles.js";
import { PixelAvatar } from "../../components/agents/PixelAvatar.js";
import { sendTaskFeedback } from "../../api/endpoints.js";
import type { Task, Agent } from "../../types/index.js";

const STATUS_COLORS: Record<string, string> = {
  inbox: "bg-gray-600",
  in_progress: "bg-blue-600",
  self_review: "bg-yellow-600",
  pr_review: "bg-purple-600",
  done: "bg-green-600",
  cancelled: "bg-red-600",
};

const SIZE_BADGES: Record<string, string> = {
  small: "text-xs bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  medium: "text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
  large: "text-xs bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
};

interface TaskCardProps {
  task: Task;
  agents: Agent[];
  onRun?: (taskId: string, agentId: string) => void;
  onStop?: (taskId: string) => void;
  onSelect?: (taskId: string) => void;
  onShowLog?: (taskId: string) => void;
}

export function TaskCard({ task, agents, onRun, onStop, onSelect, onShowLog }: TaskCardProps) {
  const agent = agents.find((a) => a.id === task.assigned_agent_id);
  const idleAgents = agents.filter((a) => a.status === "idle");
  const [selectedAgentId, setSelectedAgentId] = useState(idleAgents[0]?.id ?? "");
  const [showMessageForm, setShowMessageForm] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showMessageForm) inputRef.current?.focus();
  }, [showMessageForm]);

  const handleSendMessage = async () => {
    if (!messageText.trim() || sending) return;
    setSending(true);
    try {
      await sendTaskFeedback(task.id, messageText.trim());
      setMessageText("");
      setSent(true);
      setTimeout(() => setSent(false), 1500);
    } catch {
      // silently fail — user can retry
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-lg p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors border border-gray-200 dark:border-gray-700"
      onClick={() => onSelect?.(task.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2">
          {task.task_number && (
            <span className="text-blue-500 font-mono mr-1">{task.task_number}</span>
          )}
          {task.title}
        </h3>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase text-white ${STATUS_COLORS[task.status] ?? "bg-gray-600"}`}>
          {task.status.replace("_", " ")}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span className={`px-1.5 py-0.5 rounded ${SIZE_BADGES[task.task_size]}`}>
          {task.task_size}
        </span>
        {task.directive_id && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300">
            Directive
          </span>
        )}
        {task.depends_on && (() => { try { const deps = JSON.parse(task.depends_on); return deps.length > 0 ? (
          <span className="text-[10px] text-gray-400 dark:text-gray-500">
            &larr; {deps.join(", ")}
          </span>
        ) : null; } catch { return null; } })()}
        {agent && (
          <span className="flex items-center gap-1">
            <PixelAvatar role={agent.role} size={18} /> {agent.name}
            {getRoleLabel(agent.role) && (
              <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${getRoleColorClass(agent.role)}`}>
                {getRoleLabel(agent.role)}
              </span>
            )}
          </span>
        )}
      </div>
      {agent?.cli_model && (
        <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500 truncate" title={agent.cli_model}>
          {agent.cli_model}
        </div>
      )}

      {task.status === "inbox" && idleAgents.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          <select
            value={selectedAgentId}
            onChange={(e) => {
              e.stopPropagation();
              setSelectedAgentId(e.target.value);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
          >
            {idleAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.avatar_emoji} {a.name}{getRoleLabel(a.role) ? ` [${getRoleLabel(a.role)}]` : ""}{a.cli_model ? ` (${a.cli_model})` : ""}
              </option>
            ))}
          </select>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (selectedAgentId) onRun?.(task.id, selectedAgentId);
            }}
            disabled={!selectedAgentId}
            className="w-full px-2 py-1 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded transition-colors disabled:opacity-50"
          >
            ▶ Run
          </button>
        </div>
      )}

      {task.status !== "inbox" && (
        <div className="mt-2 flex gap-1">
          {task.status === "in_progress" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onStop?.(task.id);
              }}
              className="px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white rounded transition-colors"
            >
              Stop
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onShowLog?.(task.id);
            }}
            className="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
          >
            Log
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowMessageForm((v) => !v);
            }}
            title="Send message"
            className={`px-2 py-1 text-xs rounded transition-colors ${showMessageForm ? "bg-indigo-600 text-white" : "bg-gray-600 hover:bg-gray-500 text-white"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 inline-block">
              <path fillRule="evenodd" d="M3.43 2.524A41.29 41.29 0 0 1 10 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.1 41.1 0 0 1-3.55.414.783.783 0 0 0-.64.413l-1.713 3.293a.75.75 0 0 1-1.334 0l-1.713-3.293a.783.783 0 0 0-.64-.413 41.1 41.1 0 0 1-3.55-.414C1.993 13.245 1 11.986 1 10.574V5.426c0-1.413.993-2.67 2.43-2.902ZM7 8.5a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm5 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

      {showMessageForm && (
        <div
          className="mt-2 flex gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            type="text"
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) handleSendMessage();
              if (e.key === "Escape") setShowMessageForm(false);
            }}
            placeholder={task.status === "in_progress" ? "Send feedback..." : "Send message..."}
            disabled={sending}
            className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <button
            onClick={handleSendMessage}
            disabled={!messageText.trim() || sending}
            className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {sending ? "..." : sent ? "Sent!" : "Send"}
          </button>
        </div>
      )}
    </div>
  );
}
