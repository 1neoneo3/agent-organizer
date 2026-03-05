/**
 * DeskUnit – Pixel-art desk with monitor, chair, and a seated agent.
 *
 * Displays the agent's name, current task title, and elapsed work time.
 * The monitor screen pulses when the agent is actively working.
 * Designed for the EarthBound (Mother 2) design system.
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

/** Inline 16×16 pixel-art monitor SVG */
function MonitorSvg({ isWorking }: { isWorking: boolean }) {
  return (
    <svg
      width={48}
      height={40}
      viewBox="0 0 16 14"
      xmlns="http://www.w3.org/2000/svg"
      style={{ imageRendering: "pixelated" }}
    >
      {/* monitor bezel */}
      <rect x={1} y={0} width={14} height={10} fill="#2d2d2d" rx={0} />
      {/* screen */}
      <rect x={2} y={1} width={12} height={8} fill={isWorking ? "#0f172a" : "#1e293b"} />

      {/* screen content – code lines when working, dark when off */}
      {isWorking && (
        <>
          <rect x={3} y={2} width={6} height={1} fill="#22c55e" opacity={0.9}>
            <animate attributeName="opacity" values="0.9;0.4;0.9" dur="1.5s" repeatCount="indefinite" />
          </rect>
          <rect x={3} y={4} width={8} height={1} fill="#60a5fa" opacity={0.7}>
            <animate attributeName="opacity" values="0.7;0.3;0.7" dur="2s" repeatCount="indefinite" />
          </rect>
          <rect x={3} y={6} width={5} height={1} fill="#a855f7" opacity={0.6}>
            <animate attributeName="opacity" values="0.6;0.2;0.6" dur="1.8s" repeatCount="indefinite" />
          </rect>
          {/* blinking cursor */}
          <rect x={9} y={6} width={1} height={1} fill="#22c55e">
            <animate attributeName="opacity" values="1;0;1" dur="0.8s" repeatCount="indefinite" />
          </rect>
        </>
      )}

      {/* monitor stand */}
      <rect x={7} y={10} width={2} height={2} fill="#404040" />
      {/* stand base */}
      <rect x={5} y={12} width={6} height={1} fill="#404040" />
      <rect x={4} y={13} width={8} height={1} fill="#333333" />
    </svg>
  );
}

/** Inline pixel-art desk surface SVG */
function DeskSvg() {
  return (
    <svg
      width={120}
      height={20}
      viewBox="0 0 60 10"
      xmlns="http://www.w3.org/2000/svg"
      style={{ imageRendering: "pixelated" }}
    >
      {/* desk top surface */}
      <rect x={0} y={0} width={60} height={3} fill="var(--eb-border-out)" />
      <rect x={0} y={1} width={60} height={2} fill="var(--eb-border-in)" />
      {/* desk front panel */}
      <rect x={1} y={3} width={58} height={6} fill="var(--eb-bg-deep)" />
      <rect x={1} y={3} width={58} height={1} fill="var(--eb-border-out)" />
      {/* desk legs */}
      <rect x={2} y={9} width={3} height={1} fill="var(--eb-border-out)" />
      <rect x={55} y={9} width={3} height={1} fill="var(--eb-border-out)" />
    </svg>
  );
}

export function DeskUnit({ agent, task, onClick }: DeskUnitProps) {
  const isWorking = agent.status === "working";
  const roleLabel = getRoleLabel(agent.role);

  return (
    <div
      className="eb-window"
      style={{ cursor: onClick ? "pointer" : "default", maxWidth: 180, transition: "transform 0.1s" }}
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
          padding: "8px 8px 0",
          gap: 0,
        }}
      >
        {/* Agent sitting behind monitor */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, marginBottom: -4, zIndex: 1 }}>
          <AgentAvatar agent={agent} size={28} />
          <MonitorSvg isWorking={isWorking} />
        </div>

        {/* Desk surface */}
        <DeskSvg />
      </div>

      {/* Info panel */}
      <div className="eb-window-body" style={{ padding: "6px 8px" }}>
        {/* Agent name + role */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          <span
            className="eb-heading"
            style={{ fontSize: "9px", color: "var(--eb-text)" }}
          >
            {agent.name}
          </span>
          {roleLabel && (
            <span
              className="eb-label"
              style={{
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

        {/* Status indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: isWorking ? "#22c55e" : agent.status === "idle" ? "#fbbf24" : "#64748b",
              flexShrink: 0,
            }}
          />
          <span className="eb-label" style={{ fontSize: "7px" }}>
            {isWorking ? "WORKING" : agent.status === "idle" ? "IDLE" : "OFFLINE"}
          </span>
          {isWorking && task?.started_at && (
            <span className="eb-label" style={{ fontSize: "7px", color: "var(--eb-highlight)", marginLeft: "auto" }}>
              {formatElapsed(task.started_at)}
            </span>
          )}
        </div>

        {/* Current task */}
        {task && (
          <div
            style={{
              marginTop: 4,
              padding: "3px 5px",
              background: "var(--eb-shadow)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              className="eb-label"
              style={{
                fontSize: "7px",
                color: "var(--eb-highlight)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {task.task_number && <span style={{ marginRight: 3 }}>{task.task_number}</span>}
              {task.title}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
