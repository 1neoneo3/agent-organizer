import { useMemo, useState, type ReactNode } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { TerminalPanel } from "../terminal/TerminalPanel.js";
import { getRoleLabel, getRoleColorClass } from "../agents/roles.js";
import { PixelAvatar } from "../agents/PixelAvatar.js";
import { sendTaskFeedback } from "../../api/endpoints.js";
import { InteractivePromptPanel } from "./InteractivePromptPanel.js";
import { MarkdownContent } from "./MarkdownContent.js";
import type { Task, Agent, WSEventType, InteractivePrompt } from "../../types/index.js";
import { buildAgentViewState } from "./agent-view.js";

/**
 * Layout mode for the task detail view.
 *
 * - `modal`        — centered overlay with backdrop (default)
 * - `pinned-left`  — fixed side panel docked to the left of the main area
 * - `pinned-right` — fixed side panel docked to the right of the main area
 */
export type TaskDetailLayoutMode = "modal" | "pinned-left" | "pinned-right";

/** Width of the docked side panel (when pinned). */
export const PINNED_PANEL_WIDTH_PX = 640;

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
  layoutMode?: TaskDetailLayoutMode;
  onLayoutModeChange?: (mode: TaskDetailLayoutMode) => void;
}

export function TaskDetailModal({
  task,
  agents,
  interactivePrompt,
  on,
  subscribeTask,
  onClose,
  onRun,
  onStop,
  layoutMode = "modal",
  onLayoutModeChange,
}: TaskDetailModalProps) {
  const [activeTab, setActiveTab] = useState<"description" | "activity">("description");
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

  /**
   * Pin toggle: if we're already pinned to `side`, revert to modal.
   * Otherwise dock to the requested side.
   */
  const togglePin = (side: "left" | "right") => {
    if (!onLayoutModeChange) return;
    const pinned: TaskDetailLayoutMode = side === "left" ? "pinned-left" : "pinned-right";
    onLayoutModeChange(layoutMode === pinned ? "modal" : pinned);
  };

  const pinButtonStyle = (active: boolean) => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "4px",
    cursor: "pointer",
    background: active ? "var(--accent-subtle)" : "transparent",
    border: "1px solid " + (active ? "var(--accent-primary)" : "transparent"),
    borderRadius: "4px",
    color: active ? "var(--accent-primary)" : "var(--text-tertiary)",
    lineHeight: 0,
  });

  const panelBody: ReactNode = (
    <>
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
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            {onLayoutModeChange && (
              <>
                <button
                  type="button"
                  onClick={() => togglePin("left")}
                  title={layoutMode === "pinned-left" ? "Unpin" : "Pin to left"}
                  aria-label={layoutMode === "pinned-left" ? "Unpin task detail" : "Pin task detail to the left"}
                  aria-pressed={layoutMode === "pinned-left"}
                  style={pinButtonStyle(layoutMode === "pinned-left")}
                >
                  <PanelLeft size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => togglePin("right")}
                  title={layoutMode === "pinned-right" ? "Unpin" : "Pin to right"}
                  aria-label={layoutMode === "pinned-right" ? "Unpin task detail" : "Pin task detail to the right"}
                  aria-pressed={layoutMode === "pinned-right"}
                  style={pinButtonStyle(layoutMode === "pinned-right")}
                >
                  <PanelRight size={14} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close task detail"
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
        </div>

        {/* Body */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflowY: "auto", overflowX: "hidden", padding: "0 24px 20px" }}>
          {/* Tab bar: switch the main area between the task's Description
              content (default) and the live Activity terminal. */}
          <div
            role="tablist"
            aria-label="Task detail view"
            style={{
              display: "flex",
              gap: "4px",
              padding: "4px",
              marginBottom: "16px",
              background: "var(--bg-tertiary)",
              borderRadius: "8px",
              border: "1px solid var(--border-subtle)",
              alignSelf: "flex-start",
            }}
          >
            {(["description", "activity"] as const).map((tab) => {
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    padding: "5px 12px",
                    fontSize: "12px",
                    fontWeight: isActive ? 600 : 500,
                    color: isActive ? "var(--accent-primary)" : "var(--text-secondary)",
                    background: isActive ? "var(--bg-secondary)" : "transparent",
                    border: "1px solid " + (isActive ? "var(--border-default)" : "transparent"),
                    borderRadius: "6px",
                    cursor: "pointer",
                    boxShadow: isActive ? "var(--shadow-sm)" : "none",
                    transition: "all 0.15s ease",
                    textTransform: "none",
                    letterSpacing: "0.01em",
                  }}
                >
                  {tab === "description" ? "Description" : "Activity"}
                </button>
              );
            })}
          </div>

          {activeTab === "activity" ? (
            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <TerminalPanel
                taskId={task.id}
                on={on}
                subscribeTask={subscribeTask}
                onClose={() => setActiveTab("description")}
                agents={agents}
                currentStage={task.status}
                currentAgentId={task.assigned_agent_id}
                fullHeight
              />
            </div>
          ) : (
            <>
          {/* Repository */}
          {task.repository_url && (
            <div style={{ marginBottom: "16px" }}>
              <h3 style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
                Repository
              </h3>
              <a
                href={task.repository_url}
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
                  maxWidth: "100%",
                  overflowWrap: "anywhere",
                  wordBreak: "break-all",
                }}
              >
                <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
                {task.repository_url}
              </a>
            </div>
          )}

          {/* Description */}
          {task.description ? (
            <div style={{ marginBottom: "16px" }}>
              <h3 style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
                Description
              </h3>
              <div style={{
                background: "var(--bg-primary)",
                borderRadius: "8px",
                padding: "12px",
                border: "1px solid var(--border-subtle)",
              }}>
                <MarkdownContent content={task.description} />
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
                  maxWidth: "100%",
                  overflowWrap: "anywhere",
                  wordBreak: "break-all",
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
                overflowWrap: "anywhere",
                wordBreak: "break-word",
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

            </>
          )}
        </div>
    </>
  );

  // Modal mode: centered overlay with backdrop.
  if (layoutMode === "modal") {
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
          {panelBody}
        </div>
      </div>
    );
  }

  // Pinned mode: fixed side panel docked to the left or right of the main area.
  // No backdrop, so the user can continue interacting with the kanban board.
  const isLeft = layoutMode === "pinned-left";
  return (
    <div
      role="complementary"
      aria-label="Pinned task detail"
      style={{
        position: "fixed",
        top: 0,
        bottom: 0,
        left: isLeft ? "var(--ao-sidebar-width, 232px)" : "auto",
        right: isLeft ? "auto" : 0,
        width: `${PINNED_PANEL_WIDTH_PX}px`,
        background: "var(--bg-secondary)",
        borderLeft: isLeft ? "none" : "1px solid var(--border-default)",
        borderRight: isLeft ? "1px solid var(--border-default)" : "none",
        display: "flex",
        flexDirection: "column",
        zIndex: 40,
        boxShadow: isLeft
          ? "4px 0 12px -6px rgba(0, 0, 0, 0.2)"
          : "-4px 0 12px -6px rgba(0, 0, 0, 0.2)",
      }}
    >
      {panelBody}
    </div>
  );
}
