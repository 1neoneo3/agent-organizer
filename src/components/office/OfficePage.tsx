/**
 * OfficePage – Bird's-eye view of the virtual office.
 *
 * Two zones rendered in Linear-style design:
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

  const totalDesks = Math.max(4, deskAgents.length + 1);
  const emptyDesks = totalDesks - deskAgents.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Desk Area */}
      <section>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "12px",
        }}>
          <h2 style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Work Area</h2>
          <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-tertiary)" }}>
            {deskAgents.length} active
          </span>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
          {deskAgents.map(({ agent, task }) => (
            <div key={agent.id} className={getTransitionClass(agent.id)}>
              <DeskUnit agent={agent} task={task} />
            </div>
          ))}

          {/* Empty desk placeholders */}
          {Array.from({ length: emptyDesks }).map((_, i) => (
            <div
              key={`empty-${i}`}
              style={{
                background: "var(--bg-secondary)",
                border: "1px dashed var(--border-default)",
                borderRadius: "8px",
                maxWidth: 180,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "24px 16px",
                opacity: 0.5,
              }}
            >
              <span style={{ fontSize: "11px", fontWeight: 500, color: "var(--text-tertiary)" }}>
                Vacant
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Lobby / Waiting Area */}
      <section>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "12px",
        }}>
          <h2 style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Lobby</h2>
          <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-tertiary)" }}>
            {lobbyAgents.filter((a) => a.status === "idle").length} standby
            {" / "}
            {lobbyAgents.filter((a) => a.status === "offline").length} offline
          </span>
        </div>

        {lobbyAgents.length === 0 ? (
          <div style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: "8px",
            padding: "16px",
            textAlign: "center",
          }}>
            <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-tertiary)" }}>
              All agents are working
            </span>
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
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
