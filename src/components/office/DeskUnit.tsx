/**
 * DeskUnit – Clean card for a working agent.
 *
 * Displays the agent's name, current task title, and elapsed work time.
 * Linear-style design with status indicator.
 */
import { AgentAvatar } from "./AgentAvatar.js";
import { getRoleLabel } from "../agents/roles.js";
import type { Agent, Task } from "../../types/index.js";

interface DeskUnitProps {
  agent: Agent;
  task?: Task | null;
  onClick?: () => void;
}

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return "--:--";
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt * 1000) / 1000));
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

export function DeskUnit({ agent, task, onClick }: DeskUnitProps) {
  const isWorking = agent.status === "working";
  const roleLabel = getRoleLabel(agent.role);

  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: "8px",
        cursor: onClick ? "pointer" : "default",
        maxWidth: 200,
        transition: "border-color 0.15s ease",
      }}
      onClick={onClick}
      onMouseEnter={(e) => { if (onClick) e.currentTarget.style.borderColor = "var(--text-tertiary)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; }}
    >
      {/* Avatar area */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px 16px 8px",
      }}>
        <AgentAvatar agent={agent} size={32} />
      </div>

      {/* Info panel */}
      <div style={{ padding: "8px 14px 12px" }}>
        {/* Agent name + role */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
            {agent.name}
          </span>
          {roleLabel && (
            <span style={{
              padding: "1px 5px",
              background: "var(--accent-subtle)",
              color: "var(--accent-primary)",
              borderRadius: "3px",
              fontSize: "10px",
              fontWeight: 600,
            }}>
              {roleLabel}
            </span>
          )}
        </div>

        {/* Status indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
          <span style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: isWorking ? "#22c55e" : agent.status === "idle" ? "#f59e0b" : "#64748b",
            flexShrink: 0,
          }} />
          <span style={{ fontSize: "11px", fontWeight: 500, color: "var(--text-secondary)" }}>
            {isWorking ? "Working" : agent.status === "idle" ? "Idle" : "Offline"}
          </span>
          {isWorking && task?.started_at && (
            <span style={{ fontSize: "11px", fontWeight: 500, color: "var(--flavor-accent)", marginLeft: "auto" }}>
              {formatElapsed(task.started_at)}
            </span>
          )}
        </div>

        {/* Current task */}
        {task && (
          <div style={{
            marginTop: "6px",
            padding: "4px 8px",
            background: "var(--bg-tertiary)",
            borderRadius: "4px",
            overflow: "hidden",
          }}>
            <div style={{
              fontSize: "11px",
              fontWeight: 500,
              color: "var(--text-secondary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}>
              {task.task_number && <span style={{ color: "var(--flavor-accent)", marginRight: "4px" }}>{task.task_number}</span>}
              {task.title}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
