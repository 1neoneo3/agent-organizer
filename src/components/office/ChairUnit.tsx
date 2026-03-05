/**
 * ChairUnit – Waiting-area chair for idle / offline agents.
 *
 * Shows a pixel-art bench/chair with the agent's avatar sitting on it.
 * Much simpler than DeskUnit – no monitor, no task info.  Just the agent
 * chilling in the lobby, Mother-2 overworld style.
 */
import { AgentAvatar } from "./AgentAvatar.js";
import { getRoleLabel } from "../agents/roles.js";
import type { Agent } from "../../types/index.js";

interface ChairUnitProps {
  agent: Agent;
  onClick?: () => void;
}

/** Inline pixel-art waiting-room chair SVG */
function ChairSvg() {
  return (
    <svg
      width={56}
      height={32}
      viewBox="0 0 28 16"
      xmlns="http://www.w3.org/2000/svg"
      style={{ imageRendering: "pixelated" }}
    >
      {/* chair back */}
      <rect x={2} y={0} width={2} height={10} fill="var(--eb-border-out)" />
      <rect x={24} y={0} width={2} height={10} fill="var(--eb-border-out)" />
      <rect x={2} y={0} width={24} height={2} fill="var(--eb-border-out)" />
      <rect x={3} y={2} width={22} height={1} fill="var(--eb-border-in)" />

      {/* seat cushion */}
      <rect x={1} y={9} width={26} height={3} fill="var(--eb-border-in)" />
      <rect x={1} y={9} width={26} height={1} fill="var(--eb-border-out)" />

      {/* chair legs */}
      <rect x={3} y={12} width={2} height={4} fill="var(--eb-border-out)" />
      <rect x={23} y={12} width={2} height={4} fill="var(--eb-border-out)" />
      {/* cross bar */}
      <rect x={5} y={14} width={18} height={1} fill="var(--eb-border-in)" />
    </svg>
  );
}

export function ChairUnit({ agent, onClick }: ChairUnitProps) {
  const roleLabel = getRoleLabel(agent.role);

  return (
    <div
      className="eb-window"
      style={{
        cursor: onClick ? "pointer" : "default",
        maxWidth: 120,
        transition: "transform 0.1s",
        opacity: agent.status === "offline" ? 0.6 : 1,
      }}
      onClick={onClick}
      onMouseEnter={(e) => { if (onClick) e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; }}
    >
      {/* Visual area */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "6px 8px 0",
        }}
      >
        {/* Agent sitting on chair */}
        <div style={{ position: "relative" }}>
          {/* Avatar floats above the chair seat */}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: -8, zIndex: 1, position: "relative" }}>
            <AgentAvatar agent={agent} size={24} />
          </div>
          <ChairSvg />
        </div>
      </div>

      {/* Name label */}
      <div className="eb-window-body" style={{ padding: "4px 6px", textAlign: "center" }}>
        <div className="eb-heading" style={{ fontSize: "8px", color: "var(--eb-text)" }}>
          {agent.name}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3, marginTop: 2 }}>
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: agent.status === "idle" ? "#fbbf24" : "#64748b",
              flexShrink: 0,
            }}
          />
          <span className="eb-label" style={{ fontSize: "6px" }}>
            {agent.status === "idle" ? "STANDBY" : "OFFLINE"}
          </span>
        </div>
        {roleLabel && (
          <span
            className="eb-label"
            style={{
              display: "inline-block",
              marginTop: 2,
              padding: "1px 3px",
              background: "var(--eb-border-in)",
              color: "var(--eb-bg)",
              borderRadius: "2px",
              fontSize: "6px",
            }}
          >
            {roleLabel}
          </span>
        )}
      </div>
    </div>
  );
}
