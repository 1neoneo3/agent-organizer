import { useState } from "react";
import { AgentForm, type AgentFormData } from "./AgentForm.js";
import { createAgent, updateAgent, deleteAgent } from "../../api/endpoints.js";
import type { Agent } from "../../types/index.js";

interface AgentListProps {
  agents: Agent[];
  cliStatus: Record<string, boolean>;
  onReload: () => void;
}

export function AgentList({ agents, cliStatus, onReload }: AgentListProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleCreate = async (data: AgentFormData) => {
    await createAgent(data as unknown as Partial<Agent>);
    setShowForm(false);
    onReload();
  };

  const handleUpdate = async (data: AgentFormData) => {
    if (!editingId) return;
    await updateAgent(editingId, data as unknown as Partial<Agent>);
    setEditingId(null);
    onReload();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this agent?")) return;
    await deleteAgent(id);
    onReload();
  };

  const STATUS_DOTS: Record<string, string> = {
    idle: "bg-gray-400",
    working: "bg-green-400 animate-pulse",
    offline: "bg-red-400",
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Agents</h2>
        <div className="flex items-center gap-3">
          <div className="flex gap-2 text-xs text-gray-500 dark:text-gray-400">
            {Object.entries(cliStatus).map(([cli, ok]) => (
              <span key={cli} className={`px-2 py-1 rounded ${ok ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300" : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500"}`}>
                {cli} {ok ? "✓" : "✗"}
              </span>
            ))}
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
          >
            + New Agent
          </button>
        </div>
      </div>

      {showForm && (
        <div className="mb-4">
          <AgentForm
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      <div className="grid gap-3">
        {agents.map((agent) =>
          editingId === agent.id ? (
            <AgentForm
              key={agent.id}
              initial={agent}
              onSubmit={handleUpdate}
              onCancel={() => setEditingId(null)}
              submitLabel="Save"
            />
          ) : (
            <div
              key={agent.id}
              className="bg-white dark:bg-gray-800 rounded-lg p-4 flex items-center gap-4 border border-gray-200 dark:border-gray-700"
            >
              <span className="text-2xl">{agent.avatar_emoji}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{agent.name}</span>
                  <span className={`w-2 h-2 rounded-full ${STATUS_DOTS[agent.status]}`} />
                  <span className="text-xs text-gray-500">{agent.status}</span>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {agent.cli_provider} {agent.cli_model ? `(${agent.cli_model})` : ""} — {agent.stats_tasks_done} tasks done
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => setEditingId(agent.id)}
                  className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(agent.id)}
                  className="px-2 py-1 text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          )
        )}

        {agents.length === 0 && !showForm && (
          <div className="text-center py-12 text-gray-500">
            No agents yet. Create one to get started.
          </div>
        )}
      </div>
    </div>
  );
}
