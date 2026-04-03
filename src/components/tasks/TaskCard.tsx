import { memo, useState, useRef, useEffect } from "react";
import { getRoleColorClass } from "../../components/agents/roles.js";
import { PixelAvatar } from "../../components/agents/PixelAvatar.js";
import { sendTaskFeedback, sendInteractiveResponse } from "../../api/endpoints.js";
import { useSfx } from "../../hooks/useSfx.js";
import type { Task, Agent, InteractivePrompt } from "../../types/index.js";

const SIZE_LABEL: Record<string, string> = {
  small: "S",
  medium: "M",
  large: "L",
};

const STATUS_DISPLAY: Record<string, string> = {
  inbox: "Inbox",
  in_progress: "In Progress",
  self_review: "Review",
  qa_testing: "QA Testing",
  pr_review: "PR Review",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<string, string> = {
  inbox: "var(--status-inbox)",
  in_progress: "var(--status-progress)",
  self_review: "var(--status-review)",
  qa_testing: "var(--status-qa)",
  pr_review: "var(--status-review)",
  done: "var(--status-done)",
  cancelled: "var(--status-cancelled)",
};

const STATUS_PILL_CLASSES: Record<string, string> = {
  inbox: "status-pill-inbox",
  in_progress: "status-pill-progress",
  self_review: "status-pill-review",
  qa_testing: "status-pill-qa",
  pr_review: "status-pill-review",
  done: "status-pill-done",
  cancelled: "status-pill-cancelled",
};

const PRIORITY_COLORS: Record<number, string> = {
  1: "#ef4444",
  2: "#f59e0b",
  3: "#3b82f6",
  4: "#a0a0a0",
  5: "#a0a0a0",
};

interface TaskCardProps {
  task: Task;
  assignedAgent?: Agent;
  idleAgents: Agent[];
  roleLabelByAgentId: Map<string, string>;
  hasInteractivePrompt?: boolean;
  interactivePrompt?: InteractivePrompt;
  onRun?: (taskId: string, agentId: string) => void;
  onStop?: (taskId: string) => void;
  onDone?: (taskId: string) => void;
  onSelect?: (taskId: string) => void;
  onShowLog?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
}

function TaskCardInner({ task, assignedAgent, idleAgents, roleLabelByAgentId, hasInteractivePrompt, interactivePrompt, onRun, onStop, onDone, onSelect, onShowLog, onDelete }: TaskCardProps) {
  const agent = assignedAgent;
  const roleLabel = agent ? roleLabelByAgentId.get(agent.id) ?? null : null;
  const [selectedAgentId, setSelectedAgentId] = useState(idleAgents[0]?.id ?? "");
  const [showMessageForm, setShowMessageForm] = useState(false);
  const [sendingPromptResponse, setSendingPromptResponse] = useState(false);
  const { play } = useSfx();

  const handleApprove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!interactivePrompt || sendingPromptResponse) return;
    setSendingPromptResponse(true);
    try {
      play("confirm");
      await sendInteractiveResponse(interactivePrompt.task_id, {
        promptType: interactivePrompt.promptType,
        approved: true,
      });
    } catch {
      // silently fail
    } finally {
      setSendingPromptResponse(false);
    }
  };

  const handleReject = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!interactivePrompt || sendingPromptResponse) return;
    setSendingPromptResponse(true);
    try {
      play("cancel");
      await sendInteractiveResponse(interactivePrompt.task_id, {
        promptType: interactivePrompt.promptType,
        approved: false,
      });
    } catch {
      // silently fail
    } finally {
      setSendingPromptResponse(false);
    }
  };

  useEffect(() => {
    setSelectedAgentId((prev) => {
      const idleIds = idleAgents.map((a) => a.id);
      return idleIds.includes(prev) ? prev : (idleIds[0] ?? "");
    });
  }, [idleAgents]);
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

  const statusColor = STATUS_COLORS[task.status] ?? "var(--status-inbox)";
  const statusPillClass = STATUS_PILL_CLASSES[task.status] ?? "status-pill-inbox";
  const priorityColor = PRIORITY_COLORS[task.priority] ?? "#a0a0a0";

  return (
    <div
      className={`glass-card card-enter${hasInteractivePrompt ? " attention-border" : ""}`}
      style={{ cursor: "pointer" }}
      onClick={() => { play("select"); onSelect?.(task.id); }}
    >
      {/* Card header: title + status */}
      <div style={{ padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "13px", lineHeight: "1.4", color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>
            {task.task_number && (
              <span style={{ color: "var(--text-secondary)", marginRight: "4px", fontSize: "11px", fontWeight: 600, fontFamily: "var(--font-mono)" }}>{task.task_number}</span>
            )}
            <span style={{ wordBreak: "break-word" }}>{task.title}</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
          {hasInteractivePrompt && (
            <span className="status-pill status-pill-input">
              Input
            </span>
          )}
          <span className={`status-pill ${statusPillClass}`}>
            <span style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: statusColor,
              flexShrink: 0,
            }} />
            {STATUS_DISPLAY[task.status] ?? task.status}
          </span>
        </div>
      </div>

      {/* Plan Approval */}
      {interactivePrompt?.promptType === "exit_plan_mode" && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            padding: "8px 12px",
            background: "var(--bg-tertiary)",
            borderTop: "1px solid var(--border-default)",
            borderBottom: "1px solid var(--border-default)",
          }}
        >
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--status-progress)", marginBottom: "6px", display: "flex", alignItems: "center", gap: "4px" }}>
            Plan Approval
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              onClick={handleApprove}
              disabled={sendingPromptResponse}
              className="eb-btn eb-btn--primary"
              style={{ flex: 1, fontSize: "11px", padding: "5px 8px", opacity: sendingPromptResponse ? 0.5 : 1 }}
            >
              {sendingPromptResponse ? "..." : "Approve"}
            </button>
            <button
              onClick={handleReject}
              disabled={sendingPromptResponse}
              className="eb-btn eb-btn--danger"
              style={{ flex: 1, fontSize: "11px", padding: "5px 8px", opacity: sendingPromptResponse ? 0.5 : 1 }}
            >
              {sendingPromptResponse ? "..." : "Reject"}
            </button>
          </div>
        </div>
      )}

      {/* Agent Question / Text Input */}
      {(interactivePrompt?.promptType === "ask_user_question" || interactivePrompt?.promptType === "text_input_request") && (
        <div
          style={{
            padding: "6px 12px",
            background: "var(--bg-tertiary)",
            borderTop: "1px solid var(--border-default)",
            borderBottom: "1px solid var(--border-default)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--status-progress)", display: "flex", alignItems: "center", justifyContent: "center", gap: "4px" }}>
            {interactivePrompt.promptType === "text_input_request" ? "Input Required" : "Click to Answer"}
          </div>
        </div>
      )}

      {/* Card body */}
      <div style={{ padding: "6px 12px 10px" }}>
        {/* Metadata row */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          <span className="priority-dot" style={{ background: priorityColor }} title={`Priority ${task.priority}`} />
          <span className="status-pill" style={{
            background: "var(--bg-tertiary)",
            color: "var(--text-secondary)",
            padding: "2px 8px",
          }}>
            {SIZE_LABEL[task.task_size] ?? "?"}
          </span>
          {task.directive_id && (
            <span className="status-pill" style={{
              background: "var(--accent-subtle)",
              color: "var(--accent-primary)",
              padding: "2px 8px",
            }}>
              Directive
            </span>
          )}
          {task.depends_on && (() => { try { const deps = JSON.parse(task.depends_on); return deps.length > 0 ? (
            <span style={{ fontSize: "10px", color: "var(--text-tertiary)" }}>
              &larr; {deps.join(", ")}
            </span>
          ) : null; } catch { return null; } })()}
        </div>

        {/* Assigned agent */}
        {agent && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "6px" }}>
            <PixelAvatar role={agent.role} size={18} />
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{agent.name}</span>
            {roleLabel && (
              <span style={{
                padding: "1px 4px",
                background: "var(--bg-tertiary)",
                color: "var(--text-tertiary)",
                borderRadius: "3px",
                fontSize: "10px",
                fontWeight: 500,
              }}>
                {roleLabel}
              </span>
            )}
          </div>
        )}
        {agent?.cli_model && (
          <div style={{ fontSize: "10px", marginTop: "2px", color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
            {agent.cli_model}
          </div>
        )}

        {/* Inbox actions */}
        {task.status === "inbox" && idleAgents.length === 0 && (
          <div style={{ marginTop: "8px", display: "flex", gap: "4px" }}>
            <button
              onClick={(e) => { e.stopPropagation(); play("cancel"); onDelete?.(task.id); }}
              title="Delete task"
              className="eb-btn eb-btn--danger"
              style={{ fontSize: "11px", padding: "3px 8px" }}
            >
              Delete
            </button>
          </div>
        )}

        {task.status === "inbox" && idleAgents.length > 0 && (
          <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
            <select
              value={selectedAgentId}
              onChange={(e) => { e.stopPropagation(); setSelectedAgentId(e.target.value); }}
              onClick={(e) => e.stopPropagation()}
              className="eb-select"
              style={{ width: "100%", fontSize: "12px" }}
            >
              {idleAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{roleLabelByAgentId.get(a.id) ? ` [${roleLabelByAgentId.get(a.id)}]` : ""}{a.cli_model ? ` (${a.cli_model})` : ""}
                </option>
              ))}
            </select>
            <div style={{ display: "flex", gap: "4px" }}>
              <button
                onClick={(e) => { e.stopPropagation(); play("confirm"); if (selectedAgentId) onRun?.(task.id, selectedAgentId); }}
                disabled={!selectedAgentId}
                className="eb-btn eb-btn--primary"
                style={{ flex: 1, fontSize: "11px", padding: "4px 8px", opacity: selectedAgentId ? 1 : 0.5 }}
              >
                Run
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); play("cancel"); onDelete?.(task.id); }}
                title="Delete"
                className="eb-btn eb-btn--danger"
                style={{ fontSize: "11px", padding: "4px 8px" }}
              >
                Delete
              </button>
            </div>
          </div>
        )}

        {/* Non-inbox actions */}
        {task.status !== "inbox" && (
          <div style={{ marginTop: "8px", display: "flex", gap: "4px" }}>
            {task.status === "in_progress" && (
              <button
                onClick={(e) => { e.stopPropagation(); onStop?.(task.id); }}
                className="eb-btn eb-btn--danger"
                style={{ fontSize: "11px", padding: "3px 8px" }}
              >
                Stop
              </button>
            )}
            {task.status === "pr_review" && (
              <button
                onClick={(e) => { e.stopPropagation(); play("confirm"); onDone?.(task.id); }}
                className="eb-btn eb-btn--primary"
                style={{ fontSize: "11px", padding: "3px 8px" }}
              >
                Done
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); play("select"); onShowLog?.(task.id); }}
              className="eb-btn"
              style={{ fontSize: "11px", padding: "3px 8px" }}
            >
              Log
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); play("select"); setShowMessageForm((v) => !v); }}
              title="Send message"
              className="eb-btn"
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                background: showMessageForm ? "var(--accent-primary)" : undefined,
                color: showMessageForm ? "#fff" : undefined,
                borderColor: showMessageForm ? "var(--accent-primary)" : undefined,
              }}
            >
              Msg
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); play("cancel"); onDelete?.(task.id); }}
              title="Delete"
              className="eb-btn eb-btn--danger"
              style={{ fontSize: "11px", padding: "3px 8px" }}
            >
              Del
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
              style={{ flex: 1, minWidth: 0, fontSize: "12px" }}
            />
            <button
              onClick={handleSendMessage}
              disabled={!messageText.trim() || sending}
              className="eb-btn eb-btn--primary"
              style={{ fontSize: "11px", padding: "3px 8px", opacity: (!messageText.trim() || sending) ? 0.5 : 1 }}
            >
              {sending ? "..." : sent ? "OK!" : "Send"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function areTaskCardPropsEqual(prev: TaskCardProps, next: TaskCardProps): boolean {
  return prev.task === next.task
    && prev.assignedAgent === next.assignedAgent
    && prev.idleAgents === next.idleAgents
    && prev.hasInteractivePrompt === next.hasInteractivePrompt
    && prev.interactivePrompt === next.interactivePrompt
    && prev.onRun === next.onRun
    && prev.onStop === next.onStop
    && prev.onDone === next.onDone
    && prev.onSelect === next.onSelect
    && prev.onShowLog === next.onShowLog
    && prev.onDelete === next.onDelete
    && prev.roleLabelByAgentId === next.roleLabelByAgentId;
}

export const TaskCard = memo(TaskCardInner, areTaskCardPropsEqual);
