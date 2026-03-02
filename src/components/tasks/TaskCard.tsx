import { useState, useRef, useEffect } from "react";
import { getRoleLabel, getRoleColorClass } from "../../components/agents/roles.js";
import { PixelAvatar } from "../../components/agents/PixelAvatar.js";
import { sendTaskFeedback } from "../../api/endpoints.js";
import { useSfx } from "../../hooks/useSfx.js";
import type { Task, Agent } from "../../types/index.js";

const SIZE_TO_LV: Record<string, string> = {
  small: "LV.1",
  medium: "LV.2",
  large: "LV.3",
};

const STATUS_DISPLAY: Record<string, string> = {
  inbox: "WAITING",
  in_progress: "BATTLE",
  self_review: "CHECK",
  pr_review: "REVIEW",
  done: "CLEAR",
  cancelled: "FLED",
};

interface TaskCardProps {
  task: Task;
  agents: Agent[];
  hasInteractivePrompt?: boolean;
  onRun?: (taskId: string, agentId: string) => void;
  onStop?: (taskId: string) => void;
  onDone?: (taskId: string) => void;
  onSelect?: (taskId: string) => void;
  onShowLog?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
}

export function TaskCard({ task, agents, hasInteractivePrompt, onRun, onStop, onDone, onSelect, onShowLog, onDelete }: TaskCardProps) {
  const agent = agents.find((a) => a.id === task.assigned_agent_id);
  const idleAgents = agents.filter((a) => a.status === "idle");
  const [selectedAgentId, setSelectedAgentId] = useState(idleAgents[0]?.id ?? "");
  const [showMessageForm, setShowMessageForm] = useState(false);
  const { play } = useSfx();

  useEffect(() => {
    setSelectedAgentId((prev) => {
      const idleIds = agents.filter((a) => a.status === "idle").map((a) => a.id);
      return idleIds.includes(prev) ? prev : (idleIds[0] ?? "");
    });
  }, [agents]);
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showMessageForm) inputRef.current?.focus();
  }, [showMessageForm]);

  const handleSendMessage = async () => {
    if (!messageText.trim() || sending) return;
    setSending(true);
    try {
      await sendTaskFeedback(task.id, messageText.trim());
      setMessageText("");
      setSent(true);
      play("confirm");
      setTimeout(() => setSent(false), 1500);
    } catch {
      // silently fail
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="eb-window"
      style={{ cursor: "pointer", transition: "transform 0.1s" }}
      onClick={() => { play("select"); onSelect?.(task.id); }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; }}
    >
      {/* Card header: title + status */}
      <div style={{ padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "6px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "13px", lineHeight: "1.4", color: "var(--eb-text)", fontFamily: "system-ui, -apple-system, sans-serif" }}>
            {task.task_number && (
              <span className="eb-heading" style={{ color: "var(--eb-highlight)", marginRight: "4px", fontSize: "9px" }}>{task.task_number}</span>
            )}
            <span style={{ wordBreak: "break-word" }}>{task.title}</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
          {hasInteractivePrompt && (
            <span className="eb-label" style={{
              padding: "2px 4px",
              background: "#c08800",
              color: "#fff",
              borderRadius: "2px",
              fontSize: "7px",
              animation: "eb-blink 0.8s steps(1) infinite",
            }}>
              INPUT
            </span>
          )}
          <span className="eb-label" style={{
            padding: "2px 4px",
            background: "var(--eb-border-out)",
            color: "var(--eb-bg)",
            borderRadius: "2px",
            fontSize: "7px",
          }}>
            {STATUS_DISPLAY[task.status] ?? task.status}
          </span>
        </div>
      </div>

      {/* Card body */}
      <div className="eb-window-body" style={{ padding: "6px 10px" }}>
        {/* RPG stats row */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          <span className="eb-label" style={{
            padding: "1px 4px",
            background: "var(--eb-shadow)",
            color: "var(--eb-highlight)",
            borderRadius: "2px",
            fontSize: "7px",
          }}>
            {SIZE_TO_LV[task.task_size] ?? "LV.?"}
          </span>
          {task.directive_id && (
            <span className="eb-label" style={{
              padding: "1px 4px",
              background: "var(--eb-border-in)",
              color: "var(--eb-bg)",
              borderRadius: "2px",
              fontSize: "7px",
            }}>
              DIRECTIVE
            </span>
          )}
          {task.depends_on && (() => { try { const deps = JSON.parse(task.depends_on); return deps.length > 0 ? (
            <span className="eb-label" style={{ fontSize: "7px" }}>
              &larr; {deps.join(", ")}
            </span>
          ) : null; } catch { return null; } })()}
        </div>

        {/* Assigned agent */}
        {agent && (
          <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "4px" }}>
            <span className={agent.status === "working" ? "eb-sprite-working" : "eb-sprite-idle"}>
              <PixelAvatar role={agent.role} size={18} />
            </span>
            <span className="eb-label" style={{ fontSize: "8px", color: "var(--eb-text)" }}>{agent.name}</span>
            {getRoleLabel(agent.role) && (
              <span className="eb-label" style={{
                padding: "1px 3px",
                background: "var(--eb-border-in)",
                color: "var(--eb-bg)",
                borderRadius: "2px",
                fontSize: "6px",
              }}>
                {getRoleLabel(agent.role)}
              </span>
            )}
          </div>
        )}
        {agent?.cli_model && (
          <div className="eb-label" style={{ fontSize: "7px", marginTop: "2px", color: "var(--eb-text-sub)" }}>
            {agent.cli_model}
          </div>
        )}

        {/* Inbox actions */}
        {task.status === "inbox" && idleAgents.length === 0 && (
          <div style={{ marginTop: "6px", display: "flex", gap: "4px" }}>
            <button
              onClick={(e) => { e.stopPropagation(); play("cancel"); onDelete?.(task.id); }}
              title="Delete task"
              className="eb-btn eb-btn--danger"
              style={{ fontSize: "7px", padding: "3px 6px" }}
            >
              DEL
            </button>
          </div>
        )}

        {task.status === "inbox" && idleAgents.length > 0 && (
          <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "4px" }}>
            <select
              value={selectedAgentId}
              onChange={(e) => { e.stopPropagation(); setSelectedAgentId(e.target.value); }}
              onClick={(e) => e.stopPropagation()}
              className="eb-select"
              style={{ width: "100%", fontSize: "10px" }}
            >
              {idleAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{getRoleLabel(a.role) ? ` [${getRoleLabel(a.role)}]` : ""}{a.cli_model ? ` (${a.cli_model})` : ""}
                </option>
              ))}
            </select>
            <div style={{ display: "flex", gap: "4px" }}>
              <button
                onClick={(e) => { e.stopPropagation(); play("confirm"); if (selectedAgentId) onRun?.(task.id, selectedAgentId); }}
                disabled={!selectedAgentId}
                className="eb-btn eb-btn--primary"
                style={{ flex: 1, fontSize: "7px", padding: "4px 6px", opacity: selectedAgentId ? 1 : 0.5 }}
              >
                RUN
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); play("cancel"); onDelete?.(task.id); }}
                title="Delete"
                className="eb-btn eb-btn--danger"
                style={{ fontSize: "7px", padding: "4px 6px" }}
              >
                DEL
              </button>
            </div>
          </div>
        )}

        {/* Non-inbox actions */}
        {task.status !== "inbox" && (
          <div style={{ marginTop: "6px", display: "flex", gap: "4px" }}>
            {task.status === "in_progress" && (
              <button
                onClick={(e) => { e.stopPropagation(); onStop?.(task.id); }}
                className="eb-btn eb-btn--danger"
                style={{ fontSize: "7px", padding: "3px 6px" }}
              >
                STOP
              </button>
            )}
            {task.status === "pr_review" && (
              <button
                onClick={(e) => { e.stopPropagation(); play("confirm"); onDone?.(task.id); }}
                className="eb-btn eb-btn--primary"
                style={{ fontSize: "7px", padding: "3px 6px" }}
              >
                DONE
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); play("select"); onShowLog?.(task.id); }}
              className="eb-btn"
              style={{ fontSize: "7px", padding: "3px 6px" }}
            >
              LOG
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); play("select"); setShowMessageForm((v) => !v); }}
              title="Send message"
              className="eb-btn"
              style={{ fontSize: "7px", padding: "3px 6px", background: showMessageForm ? "var(--eb-highlight)" : undefined, color: showMessageForm ? "var(--eb-shadow)" : undefined }}
            >
              MSG
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); play("cancel"); onDelete?.(task.id); }}
              title="Delete"
              className="eb-btn eb-btn--danger"
              style={{ fontSize: "7px", padding: "3px 6px" }}
            >
              DEL
            </button>
          </div>
        )}

        {/* Message form */}
        {showMessageForm && (
          <div
            style={{ marginTop: "6px", display: "flex", gap: "4px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              type="text"
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) handleSendMessage();
                if (e.key === "Escape") setShowMessageForm(false);
              }}
              placeholder={task.status === "in_progress" ? "Feedback..." : "Message..."}
              disabled={sending}
              className="eb-input"
              style={{ flex: 1, minWidth: 0, fontSize: "10px" }}
            />
            <button
              onClick={handleSendMessage}
              disabled={!messageText.trim() || sending}
              className="eb-btn eb-btn--primary"
              style={{ fontSize: "7px", padding: "3px 6px", opacity: (!messageText.trim() || sending) ? 0.5 : 1 }}
            >
              {sending ? "..." : sent ? "OK!" : "SEND"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
