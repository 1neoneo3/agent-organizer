import { useState } from "react";
import { getRoleLabel, getRoleColorClass } from "../../components/agents/roles.js";
import { PixelAvatar } from "../../components/agents/PixelAvatar.js";
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

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-lg p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors border border-gray-200 dark:border-gray-700"
      onClick={() => onSelect?.(task.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2">{task.title}</h3>
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
        </div>
      )}
    </div>
  );
}
