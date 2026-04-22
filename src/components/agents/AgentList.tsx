import { useState } from "react";
import { AgentForm, type AgentFormData } from "./AgentForm.js";
import { getRoleLabel, getRoleColorClass } from "./roles.js";
import { PixelAvatar } from "./PixelAvatar.js";
import { createAgent, updateAgent, deleteAgent } from "../../api/endpoints.js";
import type { Agent, Task } from "../../types/index.js";
import { formatModelName } from "../../formatModelName.js";

const ACTIVE_TASK_STATUSES = new Set([
  "refinement", "in_progress", "self_review", "test_generation",
  "qa_testing", "pr_review", "human_review", "ci_check",
]);

interface AgentListProps {
  agents: Agent[];
  tasks: Task[];
  cliStatus: Record<string, boolean>;
  onReload: () => void;
}

export function AgentList({ agents, tasks, cliStatus, onReload }: AgentListProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const activeTaskCountByAgent = tasks.reduce<Record<string, number>>((acc, task) => {
    if (task.assigned_agent_id && ACTIVE_TASK_STATUSES.has(task.status)) {
      acc[task.assigned_agent_id] = (acc[task.assigned_agent_id] ?? 0) + 1;
    }
    return acc;
  }, {});

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

  const STATUS_COLORS: Record<string, string> = {
    idle: "#a0a0a0",
    working: "#22c55e",
    offline: "#ef4444",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
        <h2 style={{ fontSize: "18px", fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Agents</h2>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ display: "flex", gap: "6px" }}>
            {Object.entries(cliStatus).map(([cli, ok]) => (
              <span
                key={cli}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "3px 8px",
                  fontSize: "11px",
                  fontWeight: 500,
                  borderRadius: "4px",
                  color: ok ? "var(--status-done)" : "var(--text-tertiary)",
                  background: "var(--bg-tertiary)",
                }}
              >
                {cli} {ok ? "\u2713" : "\u2717"}
              </span>
            ))}
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="eb-btn eb-btn--primary"
          >
            + New Agent
          </button>
        </div>
      </div>

      {showForm && (
        <div style={{ marginBottom: "16px" }}>
          <AgentForm
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
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
              style={{
                background: "var(--bg-secondary)",
                border: "1px solid var(--border-default)",
                borderRadius: "8px",
                padding: "14px 16px",
                display: "flex",
                alignItems: "center",
                gap: "14px",
                transition: "border-color 0.15s ease",
              }}
            >
              <PixelAvatar role={agent.role} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "14px", fontWeight: 500, color: "var(--text-primary)" }}>{agent.name}</span>
                  {getRoleLabel(agent.role) && (
                    <span style={{
                      padding: "1px 6px",
                      borderRadius: "4px",
                      fontSize: "10px",
                      fontWeight: 600,
                      color: "var(--accent-primary)",
                      background: "var(--accent-subtle)",
                    }}>
                      {getRoleLabel(agent.role)}
                    </span>
                  )}
                  <span style={{
                    width: "7px",
                    height: "7px",
                    borderRadius: "50%",
                    background: STATUS_COLORS[agent.status] ?? "#a0a0a0",
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>{agent.status}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--text-tertiary)", marginTop: "2px" }}>
                  <span>{agent.cli_provider} {agent.cli_model ? `(${formatModelName(agent.cli_model)})` : ""} \u2014 {agent.stats_tasks_done} done</span>
                  {(activeTaskCountByAgent[agent.id] ?? 0) > 0 && (
                    <span style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "3px",
                      padding: "1px 6px",
                      borderRadius: "4px",
                      fontSize: "10px",
                      fontWeight: 600,
                      color: "var(--status-in-progress, #3b82f6)",
                      background: "rgba(59,130,246,0.12)",
                    }}>
                      {activeTaskCountByAgent[agent.id]} active
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: "4px" }}>
                <button
                  onClick={() => setEditingId(agent.id)}
                  className="eb-btn"
                  style={{ fontSize: "11px", padding: "4px 10px" }}
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(agent.id)}
                  className="eb-btn eb-btn--danger"
                  style={{ fontSize: "11px", padding: "4px 10px" }}
                >
                  Delete
                </button>
              </div>
            </div>
          )
        )}

        {agents.length === 0 && !showForm && (
          <div style={{
            textAlign: "center",
            padding: "48px",
            color: "var(--text-tertiary)",
            fontSize: "14px",
          }}>
            No agents yet. Create one to get started.
          </div>
        )}
      </div>
    </div>
  );
}
