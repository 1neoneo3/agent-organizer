import { useState } from "react";
import { TerminalPanel } from "../terminal/TerminalPanel.js";
import type { Task, Agent, WSEventType } from "../../types/index.js";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  inbox: { label: "Inbox", color: "bg-gray-600" },
  in_progress: { label: "In Progress", color: "bg-blue-600" },
  self_review: { label: "Self Review", color: "bg-yellow-600" },
  pr_review: { label: "PR Review", color: "bg-purple-600" },
  done: { label: "Done", color: "bg-green-600" },
  cancelled: { label: "Cancelled", color: "bg-red-600" },
};

const SIZE_LABELS: Record<string, { label: string; color: string }> = {
  small: { label: "Small", color: "bg-gray-500" },
  medium: { label: "Medium", color: "bg-yellow-600" },
  large: { label: "Large", color: "bg-red-600" },
};

function formatTimestamp(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface TaskDetailModalProps {
  task: Task;
  agents: Agent[];
  on: (type: WSEventType, fn: (payload: unknown) => void) => () => void;
  onClose: () => void;
  onRun?: (taskId: string, agentId: string) => void;
  onStop?: (taskId: string) => void;
}

export function TaskDetailModal({ task, agents, on, onClose, onRun, onStop }: TaskDetailModalProps) {
  const [showTerminal, setShowTerminal] = useState(task.status !== "inbox");
  const agent = agents.find((a) => a.id === task.assigned_agent_id);
  const idleAgents = agents.filter((a) => a.status === "idle");
  const [selectedAgentId, setSelectedAgentId] = useState(idleAgents[0]?.id ?? "");
  const status = STATUS_LABELS[task.status] ?? { label: task.status, color: "bg-gray-600" };
  const size = SIZE_LABELS[task.task_size] ?? { label: task.task_size, color: "bg-gray-500" };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col border border-gray-200 dark:border-gray-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 leading-snug">
              {task.title}
            </h2>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className={`px-2 py-0.5 rounded text-xs font-medium text-white ${status.color}`}>
                {status.label}
              </span>
              <span className={`px-2 py-0.5 rounded text-xs font-medium text-white ${size.color}`}>
                {size.label}
              </span>
              {agent && (
                <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                  {agent.avatar_emoji} {agent.name}
                  {agent.cli_model && (
                    <span className="ml-1 text-gray-400 dark:text-gray-500" title={agent.cli_model}>
                      ({agent.cli_model})
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none p-1"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {/* Description */}
          {task.description ? (
            <div className="mb-4">
              <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                Description
              </h3>
              <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                {task.description}
              </div>
            </div>
          ) : (
            <div className="mb-4">
              <p className="text-sm text-gray-400 dark:text-gray-500 italic">No description</p>
            </div>
          )}

          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm mb-4">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Priority</span>
              <span className="ml-2 text-gray-800 dark:text-gray-200">{task.priority}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Reviews</span>
              <span className="ml-2 text-gray-800 dark:text-gray-200">{task.review_count}</span>
            </div>
            {agent?.cli_model && (
              <div className="col-span-2">
                <span className="text-gray-500 dark:text-gray-400">Model</span>
                <span className="ml-2 text-gray-800 dark:text-gray-200 font-mono text-xs" title={agent.cli_model}>{agent.cli_model}</span>
              </div>
            )}
            {task.project_path && (
              <div className="col-span-2">
                <span className="text-gray-500 dark:text-gray-400">Project</span>
                <span className="ml-2 text-gray-800 dark:text-gray-200 font-mono text-xs">{task.project_path}</span>
              </div>
            )}
            <div>
              <span className="text-gray-500 dark:text-gray-400">Created</span>
              <span className="ml-2 text-gray-800 dark:text-gray-200">{formatTimestamp(task.created_at)}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Started</span>
              <span className="ml-2 text-gray-800 dark:text-gray-200">{formatTimestamp(task.started_at)}</span>
            </div>
            {task.completed_at && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">Completed</span>
                <span className="ml-2 text-gray-800 dark:text-gray-200">{formatTimestamp(task.completed_at)}</span>
              </div>
            )}
          </div>

          {/* Result */}
          {task.result && (
            <div className="mb-4">
              <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                Result
              </h3>
              <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap bg-green-50 dark:bg-green-900/20 rounded-lg p-3 border border-green-200 dark:border-green-800">
                {task.result}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 mb-4">
            {task.status === "inbox" && idleAgents.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">Run with:</span>
                <select
                  value={selectedAgentId}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                  className="px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                >
                  {idleAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.avatar_emoji} {a.name}{a.cli_model ? ` (${a.cli_model})` : ""}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => { if (selectedAgentId) onRun?.(task.id, selectedAgentId); }}
                  disabled={!selectedAgentId}
                  className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium disabled:opacity-50"
                >
                  ▶ Run
                </button>
              </div>
            )}
            {task.status === "in_progress" && (
              <button
                onClick={() => onStop?.(task.id)}
                className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors font-medium"
              >
                Stop Task
              </button>
            )}
            {(task.status === "in_progress" || task.status === "done" || task.status === "self_review" || task.status === "pr_review") && (
              <button
                onClick={() => setShowTerminal((v) => !v)}
                className="px-3 py-1.5 text-xs bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors font-medium"
              >
                {showTerminal ? "Hide Activity" : "⚡ Activity"}
              </button>
            )}
          </div>

          {/* Terminal */}
          {showTerminal && (
            <TerminalPanel
              taskId={task.id}
              on={on}
              onClose={() => setShowTerminal(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
