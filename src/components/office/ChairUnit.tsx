/**
 * ChairUnit – Waiting-area card for idle / offline agents.
 *
 * Shows the agent's avatar with a status indicator.
 * Clean Linear-style design.
 */
import { AgentAvatar } from "./AgentAvatar.js";
import { getRoleLabel } from "../agents/roles.js";
import type { Agent } from "../../types/index.js";

interface ChairUnitProps {
  agent: Agent;
  onClick?: () => void;
}

export function ChairUnit({ agent, onClick }: ChairUnitProps) {
  const roleLabel = getRoleLabel(agent.role);

  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: "8px",
        cursor: onClick ? "pointer" : "default",
        maxWidth: 120,
        transition: "border-color 0.15s ease",
        opacity: agent.status === "offline" ? 0.6 : 1,
      }}
      onClick={onClick}
      onMouseEnter={(e) => { if (onClick) e.currentTarget.style.borderColor = "var(--text-tertiary)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; }}
    >
      {/* Avatar */}
      <div style={{
        display: "flex",
        justifyContent: "center",
        padding: "12px 12px 4px",
      }}>
        <AgentAvatar agent={agent} size={28} />
      </div>

      {/* Name + status */}
      <div style={{ padding: "4px 10px 10px", textAlign: "center" }}>
        <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
          {agent.name}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", marginTop: "3px" }}>
          <span style={{
            width: "5px",
            height: "5px",
            borderRadius: "50%",
            background: agent.status === "idle" ? "#f59e0b" : "#64748b",
            flexShrink: 0,
          }} />
          <span style={{ fontSize: "10px", fontWeight: 500, color: "var(--text-tertiary)" }}>
            {agent.status === "idle" ? "Standby" : "Offline"}
          </span>
        </div>
        {roleLabel && (
          <span style={{
            display: "inline-block",
            marginTop: "3px",
            padding: "1px 5px",
            background: "var(--accent-subtle)",
            color: "var(--accent-primary)",
            borderRadius: "3px",
            fontSize: "9px",
            fontWeight: 600,
          }}>
            {roleLabel}
          </span>
        )}
      </div>
    </div>
  );
}
