import { useMemo, useState } from "react";
import { TerminalPanel } from "../terminal/TerminalPanel.js";
import { getRoleLabel, getRoleColorClass } from "../agents/roles.js";
import { PixelAvatar } from "../agents/PixelAvatar.js";
import { sendTaskFeedback } from "../../api/endpoints.js";
import { InteractivePromptPanel } from "./InteractivePromptPanel.js";
import type { Task, Agent, WSEventType, InteractivePrompt } from "../../types/index.js";
import { buildAgentViewState } from "./agent-view.js";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  inbox: { label: "Inbox", color: "var(--status-inbox)" },
  in_progress: { label: "In Progress", color: "var(--status-progress)" },
  self_review: { label: "Self Review", color: "var(--status-review)" },
  test_generation: { label: "Test Gen", color: "var(--status-test-gen)" },
  qa_testing: { label: "QA Testing", color: "var(--status-qa)" },
  pr_review: { label: "PR Review", color: "var(--status-review)" },
  human_review: { label: "Human Review", color: "var(--status-human-review)" },
  pre_deploy: { label: "Pre Deploy", color: "var(--status-pre-deploy)" },
  done: { label: "Done", color: "var(--status-done)" },
  cancelled: { label: "Cancelled", color: "var(--status-cancelled)" },
};

const SIZE_LABELS: Record<string, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

function formatTimestamp(ts: number | null): string {
  if (!ts) return "\u2014";
  return new Date(ts).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface TaskDetailModalProps {
  task: Task;
  agents: Agent[];
  interactivePrompt?: InteractivePrompt;
  on: (type: WSEventType, fn: (payload: unknown) => void) => () => void;
  subscribeTask?: (taskId: string) => () => void;
  onClose: () => void;
  onRun?: (taskId: string, agentId: string) => void;
  onStop?: (taskId: string) => void;
}

export function TaskDetailModal({ task, agents, interactivePrompt, on, subscribeTask, onClose, onRun, onStop }: TaskDetailModalProps) {
  const [showTerminal, setShowTerminal] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const agentView = useMemo(() => buildAgentViewState(agents), [agents]);
  const agent = task.assigned_agent_id ? agentView.agentById.get(task.assigned_agent_id) : undefined;
  const idleAgents = agentView.idleAgents;
  const [selectedAgentId, setSelectedAgentId] = useState(idleAgents[0]?.id ?? "");
  const roleLabel = agent ? agentView.roleLabelById.get(agent.id) ?? null : null;

  const handleSendFeedback = async () => {
    if (!feedbackText.trim()) return;
    setSendingFeedback(true);
    try {
      await sendTaskFeedback(task.id, feedbackText.trim());
      setFeedbackText("");
    } catch (err) {
      console.error("Failed to send feedback:", err);
    } finally {
      setSendingFeedback(false);
    }
  };
  const status = STATUS_LABELS[task.status] ?? { label: task.status, color: "var(--status-inbox)" };
  const sizeLabel = SIZE_LABELS[task.task_size] ?? task.task_size;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: "12px",
          width: "100%",
          maxWidth: "56rem",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", padding: "20px 24px 12px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", lineHeight: 1.4, margin: 0 }}>
              {task.title}
            </h2>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
              <span style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "2px 8px",
                borderRadius: "4px",
                fontSize: "11px",
                fontWeight: 600,
                color: status.color,
                background: "var(--bg-tertiary)",
              }}>
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: status.color }} />
                {status.label}
              </span>
              <span style={{
                padding: "2px 8px",
                borderRadius: "4px",
                fontSize: "11px",
                fontWeight: 500,
                color: "var(--text-secondary)",
                background: "var(--bg-tertiary)",
              }}>
                {sizeLabel}
              </span>
              {agent && (
                <span style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  fontSize: "11px",
                  fontWeight: 500,
                  color: "var(--text-secondary)",
                  background: "var(--bg-tertiary)",
                }}>
                  <PixelAvatar role={agent.role} size={14} className="inline-block align-middle" />
                  {agent.name}
                  {agent.cli_model && (
                    <span style={{ color: "var(--text-tertiary)" }}>({agent.cli_model})</span>
                  )}
                </span>
              )}
              {roleLabel && (
                <span style={{
                  padding: "2px 8px",
                  borderRadius: "4px",
                  fontSize: "11px",
                  fontWeight: 500,
                  color: "var(--accent-primary)",
                  background: "var(--accent-subtle)",
                }}>
                  {roleLabel}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              color: "var(--text-tertiary)",
              fontSize: "16px",
              lineHeight: 1,
              padding: "4px",
              cursor: "pointer",
              background: "none",
              border: "none",
              borderRadius: "4px",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
          >
            &#x2715;
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 20px" }}>
          {/* Description */}
          {task.description ? (
            <div style={{ marginBottom: "16px" }}>
              <h3 style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
                Description
              </h3>
              <div style={{
                fontSize: "13px",
                color: "var(--text-primary)",
                whiteSpace: "pre-wrap",
                background: "var(--bg-tertiary)",
                borderRadius: "8px",
                padding: "12px",
                border: "1px solid var(--border-subtle)",
              }}>
                {task.description}
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: "16px" }}>
              <p style={{ fontSize: "13px", color: "var(--text-tertiary)", fontStyle: "italic" }}>No description</p>
            </div>
          )}

          {/* Metadata grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px", fontSize: "13px", marginBottom: "16px" }}>
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>Priority</span>
              <span style={{ marginLeft: "8px", color: "var(--text-primary)" }}>{task.priority}</span>
            </div>
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>Reviews</span>
              <span style={{ marginLeft: "8px", color: "var(--text-primary)" }}>{task.review_count}</span>
            </div>
            {agent?.cli_model && (
              <div style={{ gridColumn: "span 2" }}>
                <span style={{ color: "var(--text-tertiary)" }}>Model</span>
                <span style={{ marginLeft: "8px", color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontSize: "12px" }}>{agent.cli_model}</span>
              </div>
            )}
            {task.project_path && (
              <div style={{ gridColumn: "span 2" }}>
                <span style={{ color: "var(--text-tertiary)" }}>Project</span>
                <span style={{ marginLeft: "8px", color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontSize: "12px" }}>{task.project_path}</span>
              </div>
            )}
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>Created</span>
              <span style={{ marginLeft: "8px", color: "var(--text-primary)" }}>{formatTimestamp(task.created_at)}</span>
            </div>
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>Started</span>
              <span style={{ marginLeft: "8px", color: "var(--text-primary)" }}>{formatTimestamp(task.started_at)}</span>
            </div>
            {task.completed_at && (
              <div>
                <span style={{ color: "var(--text-tertiary)" }}>Completed</span>
                <span style={{ marginLeft: "8px", color: "var(--text-primary)" }}>{formatTimestamp(task.completed_at)}</span>
              </div>
            )}
          </div>

          {/* PR Link */}
          {task.pr_url && (
            <div style={{ marginBottom: "16px" }}>
              <h3 style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
                Pull Request
              </h3>
              <a
                href={task.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "13px",
                  color: "var(--accent-primary)",
                  textDecoration: "none",
                  background: "var(--accent-subtle)",
                  borderRadius: "6px",
                  padding: "6px 12px",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16"><path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/></svg>
                {task.pr_url}
              </a>
            </div>
          )}

          {/* Result */}
          {task.result && (
            <div style={{ marginBottom: "16px" }}>
              <h3 style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
                Result
              </h3>
              <div style={{
                fontSize: "13px",
                color: "var(--text-primary)",
                whiteSpace: "pre-wrap",
                background: "var(--bg-tertiary)",
                borderRadius: "8px",
                padding: "12px",
                border: "1px solid var(--border-subtle)",
              }}>
                {task.result}
              </div>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
            {task.status === "inbox" && idleAgents.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-tertiary)", flexShrink: 0 }}>Run with:</span>
                <select
                  value={selectedAgentId}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                  style={{
                    padding: "4px 8px",
                    fontSize: "12px",
                    borderRadius: "6px",
                    border: "1px solid var(--border-default)",
                    background: "var(--bg-tertiary)",
                    color: "var(--text-primary)",
                    outline: "none",
                  }}
                >
                  {idleAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.avatar_emoji} {a.name}{agentView.roleLabelById.get(a.id) ? ` [${agentView.roleLabelById.get(a.id)}]` : ""}{a.cli_model ? ` (${a.cli_model})` : ""}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => { if (selectedAgentId) onRun?.(task.id, selectedAgentId); }}
                  disabled={!selectedAgentId}
                  className="eb-btn eb-btn--primary"
                  style={{ fontSize: "12px" }}
                >
                  Run
                </button>
              </div>
            )}
            {task.status === "in_progress" && (
              <button
                onClick={() => onStop?.(task.id)}
                className="eb-btn eb-btn--danger"
                style={{ fontSize: "12px" }}
              >
                Stop Task
              </button>
            )}
            {(task.status === "in_progress" || task.status === "done" || task.status === "self_review" || task.status === "test_generation" || task.status === "qa_testing" || task.status === "pr_review" || task.status === "human_review" || task.status === "pre_deploy") && (
              <button
                onClick={() => setShowTerminal((v) => !v)}
                className="eb-btn"
                style={{ fontSize: "12px" }}
              >
                {showTerminal ? "Hide Activity" : "Activity"}
              </button>
            )}
          </div>

          {/* Interactive Prompt */}
          {interactivePrompt && (
            <div style={{ marginBottom: "16px" }}>
              <InteractivePromptPanel prompt={interactivePrompt} />
            </div>
          )}

          {/* CEO Feedback */}
          {task.status === "in_progress" && (
            <div style={{ marginBottom: "16px" }}>
              <h3 style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
                Feedback
              </h3>
              <div style={{ display: "flex", gap: "8px" }}>
                <textarea
                  style={{
                    flex: 1,
                    background: "var(--bg-tertiary)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "6px",
                    padding: "8px 12px",
                    fontSize: "13px",
                    color: "var(--text-primary)",
                    height: "64px",
                    resize: "none",
                    outline: "none",
                  }}
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  placeholder="Send feedback to the running agent..."
                />
                <button
                  onClick={handleSendFeedback}
                  disabled={!feedbackText.trim() || sendingFeedback}
                  className="eb-btn eb-btn--primary"
                  style={{ alignSelf: "flex-end", fontSize: "12px", opacity: (!feedbackText.trim() || sendingFeedback) ? 0.5 : 1 }}
                >
                  {sendingFeedback ? "..." : "Send"}
                </button>
              </div>
            </div>
          )}

          {/* Terminal */}
          {showTerminal && (
            <TerminalPanel
              taskId={task.id}
              on={on}
              subscribeTask={subscribeTask}
              onClose={() => setShowTerminal(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
