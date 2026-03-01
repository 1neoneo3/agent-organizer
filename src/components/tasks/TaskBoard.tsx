import { useState } from "react";
import { useNavigate } from "react-router";
import { TaskCard } from "./TaskCard.js";
import { CreateTaskModal } from "./CreateTaskModal.js";
import { TaskDetailModal } from "./TaskDetailModal.js";
import { TerminalPanel } from "../terminal/TerminalPanel.js";
import { createTask, runTask, stopTask, createAgent } from "../../api/endpoints.js";
import { AgentForm, type AgentFormData } from "../agents/AgentForm.js";
import { getRoleLabel } from "../agents/roles.js";
import { PixelAvatar } from "../agents/PixelAvatar.js";
import type { Task, Agent } from "../../types/index.js";
import { useWebSocket } from "../../hooks/useWebSocket.js";

const COLUMNS = [
  { key: "inbox", label: "Inbox", color: "border-gray-500" },
  { key: "in_progress", label: "In Progress", color: "border-blue-500" },
  { key: "self_review", label: "Self Review", color: "border-yellow-500" },
  { key: "pr_review", label: "PR Review", color: "border-purple-500" },
  { key: "done", label: "Done", color: "border-green-500" },
] as const;

interface TaskBoardProps {
  tasks: Task[];
  agents: Agent[];
  onReload: () => void;
}

export function TaskBoard({ tasks, agents, onReload }: TaskBoardProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [logTaskId, setLogTaskId] = useState<string | null>(null);
  const { on } = useWebSocket();
  const navigate = useNavigate();

  const handleCreate = async (data: Parameters<typeof createTask>[0]) => {
    await createTask(data);
    setShowCreate(false);
    onReload();
  };

  const handleRun = async (taskId: string, agentId: string) => {
    await runTask(taskId, agentId);
    onReload();
  };

  const handleStop = async (taskId: string) => {
    await stopTask(taskId);
    onReload();
  };

  const handleAddAgent = async (data: AgentFormData) => {
    await createAgent(data as unknown as Partial<Agent>);
    setShowAddAgent(false);
    onReload();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold">Task Board</h2>
          {agents.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              {agents.map((a) => (
                <span
                  key={a.id}
                  className={`px-2 py-0.5 rounded ${a.status === "working" ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}
                  title={`${a.name} (${a.status})`}
                >
                  <PixelAvatar role={a.role} size={16} className="inline-block align-middle" /> {a.name}{getRoleLabel(a.role) ? ` [${getRoleLabel(a.role)}]` : ""}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddAgent(true)}
            className="px-3 py-2 text-sm bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 rounded transition-colors"
          >
            + Agent
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
          >
            + New Task
          </button>
        </div>
      </div>

      {agents.length === 0 && tasks.length === 0 && !showAddAgent && (
        <div className="flex flex-col items-center justify-center py-16 text-gray-500">
          <p className="text-lg mb-2">No agents yet</p>
          <p className="text-sm mb-4">Create an agent to start running tasks</p>
          <button
            onClick={() => setShowAddAgent(true)}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
          >
            + Create First Agent
          </button>
        </div>
      )}

      <div className="flex gap-3 overflow-x-auto">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.key);
          return (
            <div key={col.key} className={`flex-1 min-w-[220px] max-w-[320px]`}>
              <div className={`border-t-2 ${col.color} mb-2 pt-2`}>
                <div className="flex items-center justify-between px-1">
                  <h3 className="text-sm font-medium text-gray-600 dark:text-gray-300">{col.label}</h3>
                  <span className="text-xs text-gray-500">{colTasks.length}</span>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {colTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    agents={agents}
                    onRun={handleRun}
                    onStop={handleStop}
                    onSelect={setSelectedTaskId}
                    onShowLog={setLogTaskId}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {selectedTaskId && (() => {
        const selectedTask = tasks.find((t) => t.id === selectedTaskId);
        if (!selectedTask) return null;
        return (
          <TaskDetailModal
            task={selectedTask}
            agents={agents}
            on={on}
            onClose={() => setSelectedTaskId(null)}
            onRun={handleRun}
            onStop={handleStop}
          />
        );
      })()}

      {showAddAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <AgentForm
            onSubmit={handleAddAgent}
            onCancel={() => setShowAddAgent(false)}
          />
        </div>
      )}

      {showCreate && (
        <CreateTaskModal
          agents={agents}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}

      {logTaskId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setLogTaskId(null)}
        >
          <div
            className="w-full max-w-4xl max-h-[85vh] mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <TerminalPanel
              taskId={logTaskId}
              on={on}
              onClose={() => setLogTaskId(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
