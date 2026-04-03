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
                  padding: "3px 10px",
                  fontSize: "11px",
                  fontWeight: 500,
                  borderRadius: "12px",
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
                background: "var(--glass-bg)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                border: "1px solid var(--glass-border)",
                borderRadius: "14px",
                padding: "16px 18px",
                display: "flex",
                alignItems: "center",
                gap: "14px",
                boxShadow: "var(--glass-shadow)",
                transition: "all 0.25s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = "var(--glass-shadow-hover)";
                e.currentTarget.style.transform = "translateY(-2px)";
                e.currentTarget.style.borderColor = "var(--border-default)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = "var(--glass-shadow)";
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.borderColor = "var(--glass-border)";
              }}
            >
              <PixelAvatar role={agent.role} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>{agent.name}</span>
                  {getRoleLabel(agent.role) && (
                    <span style={{
                      padding: "2px 8px",
                      borderRadius: "10px",
                      fontSize: "10px",
                      fontWeight: 600,
                      color: "var(--accent-primary)",
                      background: "var(--accent-subtle)",
                    }}>
                      {getRoleLabel(agent.role)}
                    </span>
                  )}
                  <span
                    className={agent.status === "working" ? "status-dot-working" : ""}
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      background: STATUS_COLORS[agent.status] ?? "#a0a0a0",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontSize: "11px", color: "var(--text-tertiary)", fontWeight: 500 }}>{agent.status}</span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-tertiary)", marginTop: "3px" }}>
                  {agent.cli_provider} {agent.cli_model ? `(${agent.cli_model})` : ""} \u2014 {agent.stats_tasks_done} tasks done
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  onClick={() => setEditingId(agent.id)}
                  className="eb-btn"
                  style={{ fontSize: "11px", padding: "5px 12px" }}
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(agent.id)}
                  className="eb-btn eb-btn--danger"
                  style={{ fontSize: "11px", padding: "5px 12px" }}
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
            background: "var(--glass-bg)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            borderRadius: "16px",
            border: "1px solid var(--glass-border)",
          }}>
            No agents yet. Create one to get started.
          </div>
        )}
      </div>
    </div>
  );
}
