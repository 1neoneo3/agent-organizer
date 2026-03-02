/**
 * OfficePage – Bird's-eye view of the virtual office.
 *
 * Two zones rendered in the EarthBound design system:
 *   1. **Desk area** – agents with status "working" sit at desks with monitors.
 *   2. **Lobby / waiting area** – idle and offline agents chill on chairs.
 *
 * Agents slide between zones in real-time as WebSocket events arrive.
 */
import { DeskUnit } from "./DeskUnit.js";
import { ChairUnit } from "./ChairUnit.js";
import { useOfficeStatus } from "../../hooks/useOfficeStatus.js";
import type { Agent, Task, WSEventType } from "../../types/index.js";

type WsOn = (type: WSEventType, fn: (payload: unknown) => void) => () => void;

interface OfficePageProps {
  agents: Agent[];
  tasks: Task[];
  on: WsOn;
}

function EmptyDeskSvg() {
  return (
    <svg
      width={120}
      height={60}
      viewBox="0 0 60 30"
      xmlns="http://www.w3.org/2000/svg"
      style={{ imageRendering: "pixelated", opacity: 0.35 }}
    >
      {/* monitor bezel (off) */}
      <rect x={20} y={2} width={20} height={14} fill="#2d2d2d" />
      <rect x={21} y={3} width={18} height={12} fill="#1e293b" />
      {/* monitor stand */}
      <rect x={29} y={16} width={2} height={3} fill="#404040" />
      <rect x={26} y={19} width={8} height={1} fill="#333" />
      {/* desk surface */}
      <rect x={0} y={22} width={60} height={3} fill="var(--eb-border-out)" />
      <rect x={0} y={23} width={60} height={2} fill="var(--eb-border-in)" />
      {/* desk front */}
      <rect x={1} y={25} width={58} height={4} fill="var(--eb-bg-deep)" />
      <rect x={1} y={25} width={58} height={1} fill="var(--eb-border-out)" />
      {/* legs */}
      <rect x={2} y={29} width={3} height={1} fill="var(--eb-border-out)" />
      <rect x={55} y={29} width={3} height={1} fill="var(--eb-border-out)" />
    </svg>
  );
}

export function OfficePage({ agents, tasks, on }: OfficePageProps) {
  const { deskAgents, lobbyAgents, transitions } = useOfficeStatus(agents, tasks, on);

  const getTransitionClass = (agentId: string): string => {
    const t = transitions.find((tr) => tr.agentId === agentId);
    if (!t) return "";
    switch (t.kind) {
      case "enter_desk":
        return "office-enter-desk";
      case "leave_desk":
        return "office-leave-desk";
      case "go_offline":
        return "office-go-offline";
      case "come_online":
        return "office-come-online";
      default:
        return "";
    }
  };

  // Calculate empty desk slots for a visually consistent grid
  const totalDesks = Math.max(4, deskAgents.length + 1); // always show at least one empty desk
  const emptyDesks = totalDesks - deskAgents.length;

  return (
    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: 16, height: "100%", overflow: "auto" }}>
      {/* ---- Desk Area ---- */}
      <section>
        <div className="eb-window" style={{ marginBottom: 8 }}>
          <div className="eb-window-header">
            <span>WORK AREA</span>
            <span className="eb-label" style={{ marginLeft: "auto", fontSize: "7px" }}>
              {deskAgents.length} ACTIVE
            </span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            padding: "8px 0",
          }}
        >
          {deskAgents.map(({ agent, task }) => (
            <div key={agent.id} className={getTransitionClass(agent.id)}>
              <DeskUnit agent={agent} task={task} />
            </div>
          ))}

          {/* Empty desk placeholders */}
          {Array.from({ length: emptyDesks }).map((_, i) => (
            <div
              key={`empty-${i}`}
              className="eb-window"
              style={{
                maxWidth: 180,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px 8px",
                opacity: 0.5,
              }}
            >
              <EmptyDeskSvg />
              <div className="eb-label" style={{ fontSize: "7px", marginTop: 6, color: "var(--eb-text-sub)" }}>
                VACANT
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Lobby / Waiting Area ---- */}
      <section>
        <div className="eb-window" style={{ marginBottom: 8 }}>
          <div className="eb-window-header">
            <span>LOBBY</span>
            <span className="eb-label" style={{ marginLeft: "auto", fontSize: "7px" }}>
              {lobbyAgents.filter((a) => a.status === "idle").length} STANDBY
              {" / "}
              {lobbyAgents.filter((a) => a.status === "offline").length} OFFLINE
            </span>
          </div>
        </div>

        {lobbyAgents.length === 0 ? (
          <div
            className="eb-window"
            style={{
              padding: "16px 12px",
              textAlign: "center",
            }}
          >
            <span className="eb-label" style={{ fontSize: "8px", color: "var(--eb-text-sub)" }}>
              ALL AGENTS ARE WORKING
            </span>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              padding: "8px 0",
            }}
          >
            {lobbyAgents.map((agent) => (
              <div key={agent.id} className={getTransitionClass(agent.id)}>
                <ChairUnit agent={agent} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
