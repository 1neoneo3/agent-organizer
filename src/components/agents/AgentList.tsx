import { useState } from "react";
import { AgentForm, type AgentFormData } from "./AgentForm.js";
import { getRoleLabel, getRoleColorClass } from "./roles.js";
import { PixelAvatar } from "./PixelAvatar.js";
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

  const STATUS_COLORS: Record<string, string> = {
    idle: "#a0a0a0",
    working: "#22c55e",
    offline: "#ef4444",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
        <h2 className="page-title-gradient" style={{ fontSize: "20px", fontWeight: 700, margin: 0 }}>Agents</h2>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ display: "flex", gap: "6px" }}>
            {Object.entries(cliStatus).map(([cli, ok]) => (
              <span
                key={cli}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "3px 10px",
                  fontSize: "11px",
                  fontWeight: 500,
                  borderRadius: "999px",
                  color: ok ? "#4ade80" : "var(--text-tertiary)",
                  background: ok ? "rgba(34, 197, 94, 0.1)" : "var(--bg-tertiary)",
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
              className={`glass-card animate-fade-in-up${agent.status === "working" ? " agent-card-working agent-card-working-border" : ""}${agent.status === "idle" ? " agent-card-idle" : ""}`}
              style={{
                padding: "14px 16px",
                display: "flex",
                alignItems: "center",
                gap: "14px",
              }}
            >
              <div style={{ position: "relative" }}>
                <PixelAvatar role={agent.role} size={36} />
                <span
                  className={agent.status === "working" ? "status-dot-pulse" : ""}
                  style={{
                    position: "absolute",
                    bottom: "-2px",
                    right: "-2px",
                    width: "10px",
                    height: "10px",
                    borderRadius: "50%",
                    background: STATUS_COLORS[agent.status] ?? "#a0a0a0",
                    border: "2px solid var(--bg-primary)",
                    boxShadow: agent.status === "working" ? "0 0 8px rgba(34, 197, 94, 0.5)" : "none",
                  }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "14px", fontWeight: 500, color: "var(--text-primary)" }}>{agent.name}</span>
                  {getRoleLabel(agent.role) && (
                    <span style={{
                      padding: "2px 8px",
                      borderRadius: "999px",
                      fontSize: "10px",
                      fontWeight: 600,
                      color: "var(--accent-primary)",
                      background: "var(--accent-subtle)",
                    }}>
                      {getRoleLabel(agent.role)}
                    </span>
                  )}
                  <span style={{
                    padding: "2px 8px",
                    borderRadius: "999px",
                    fontSize: "10px",
                    fontWeight: 500,
                    background: agent.status === "working"
                      ? "rgba(34, 197, 94, 0.1)"
                      : agent.status === "offline"
                      ? "rgba(239, 68, 68, 0.1)"
                      : "var(--bg-tertiary)",
                    color: agent.status === "working"
                      ? "#4ade80"
                      : agent.status === "offline"
                      ? "#f87171"
                      : "var(--text-tertiary)",
                  }}>
                    {agent.status}
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-tertiary)", marginTop: "2px" }}>
                  {agent.cli_provider} {agent.cli_model ? `(${agent.cli_model})` : ""} \u2014 {agent.stats_tasks_done} tasks done
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
          <div className="glass-card empty-state-shimmer" style={{
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
