import { memo, useState, useRef, useEffect } from "react";
import { getRoleColorClass } from "../../components/agents/roles.js";
import { PixelAvatar } from "../../components/agents/PixelAvatar.js";
import { sendTaskFeedback, sendInteractiveResponse, approveTask, rejectTask } from "../../api/endpoints.js";
import { useSfx } from "../../hooks/useSfx.js";
import type { Task, Agent, InteractivePrompt } from "../../types/index.js";

const SIZE_LABEL: Record<string, string> = {
  small: "S",
  medium: "M",
  large: "L",
};

const STATUS_DISPLAY: Record<string, string> = {
  inbox: "Inbox",
  refinement: "Refinement",
  in_progress: "In Progress",
  self_review: "Review",
  test_generation: "Test Gen",
  qa_testing: "QA Testing",
  pr_review: "PR Review",
  human_review: "Human Review",
  ci_check: "Pre Deploy",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<string, string> = {
  inbox: "var(--status-inbox)",
  refinement: "var(--status-refinement)",
  in_progress: "var(--status-progress)",
  self_review: "var(--status-review)",
  test_generation: "var(--status-test-gen)",
  qa_testing: "var(--status-qa)",
  pr_review: "var(--status-review)",
  human_review: "var(--status-human-review)",
  ci_check: "var(--status-ci-check)",
  done: "var(--status-done)",
  cancelled: "var(--status-cancelled)",
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

  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: "8px",
        cursor: "pointer",
        boxShadow: "var(--shadow-card)",
        transform: "translateY(0)",
        transition: "border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease",
      }}
      onClick={() => { play("select"); onSelect?.(task.id); }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--text-tertiary)";
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.boxShadow = "var(--shadow-md)";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-default)";
        e.currentTarget.style.background = "var(--bg-secondary)";
        e.currentTarget.style.boxShadow = "var(--shadow-card)";
        e.currentTarget.style.transform = "translateY(0)";
      }}
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
          {/* Parent/child relationship + dependency display */}
          {(() => {
            const lines: Array<{ label: string; color: string; values: string[] }> = [];
            // Child → show parent
            const parentMatch = task.description?.match(/^Step \d+ of (#\d+)/);
            if (parentMatch) {
              lines.push({ label: "Parent", color: "var(--status-refinement)", values: [parentMatch[1]] });
            }
            // Parent → show children
            const childMatch = task.result?.match(/^Split into (#[\d, #]+)/);
            if (childMatch) {
              const children = childMatch[1].split(", ").map(s => s.trim());
              lines.push({ label: "Children", color: "var(--status-refinement)", values: children });
            }
            // Blocked by
            if (task.depends_on) {
              try {
                const deps = JSON.parse(task.depends_on) as string[];
                if (deps.length > 0) lines.push({ label: "Blocked by", color: "var(--status-cancelled)", values: deps });
              } catch { /* ignore */ }
            }
            if (lines.length === 0) return null;
            return (
              <div style={{ marginTop: "2px", display: "flex", flexDirection: "column", gap: "1px" }}>
                {lines.map((line) => (
                  <div key={line.label} style={{ fontSize: "10px", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
                    <span style={{ color: line.color, fontWeight: 600 }}>{line.label}</span>
                    {line.values.map((v) => (
                      <span key={v} style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{v}</span>
                    ))}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
          {hasInteractivePrompt && (
            <span style={{
              padding: "2px 6px",
              background: "#f59e0b",
              color: "#fff",
              borderRadius: "4px",
              fontSize: "10px",
              fontWeight: 600,
            }}>
              Input
            </span>
          )}
          <span style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 6px",
            borderRadius: "4px",
            fontSize: "10px",
            fontWeight: 600,
            color: statusColor,
            background: "var(--bg-tertiary)",
          }}>
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

      {/* Refinement Plan — review prompt */}
      {task.status === "refinement" && task.refinement_plan && (
        <div
          style={{
            padding: "8px 12px",
            background: "var(--bg-tertiary)",
            borderTop: "1px solid var(--border-default)",
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--status-refinement)" }}>
            Refinement Plan Ready
          </span>
          <button
            onClick={() => { play("select"); onSelect?.(task.id); }}
            className="eb-btn eb-btn--primary"
            style={{ fontSize: "11px", padding: "4px 12px" }}
          >
            Review
          </button>
        </div>
      )}

      {/* Human Review Approval */}
      {task.status === "human_review" && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            padding: "8px 12px",
            background: "var(--bg-tertiary)",
            borderTop: "1px solid var(--border-default)",
            borderBottom: "1px solid var(--border-default)",
          }}
        >
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--status-human-review)", marginBottom: "6px", display: "flex", alignItems: "center", gap: "4px" }}>
            Human Review Required
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              onClick={async () => { play("confirm"); await approveTask(task.id); }}
              className="eb-btn eb-btn--primary"
              style={{ flex: 1, fontSize: "11px", padding: "5px 8px" }}
            >
              Approve
            </button>
            <button
              onClick={async () => { play("select"); await rejectTask(task.id); }}
              className="eb-btn eb-btn--danger"
              style={{ flex: 1, fontSize: "11px", padding: "5px 8px" }}
            >
              Reject
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
          <span style={{
            padding: "1px 6px",
            background: "var(--bg-tertiary)",
            color: "var(--text-secondary)",
            borderRadius: "4px",
            fontSize: "10px",
            fontWeight: 600,
          }}>
            {SIZE_LABEL[task.task_size] ?? "?"}
          </span>
          {task.directive_id && (
            <span style={{
              padding: "1px 6px",
              background: "var(--accent-subtle)",
              color: "var(--accent-primary)",
              borderRadius: "4px",
              fontSize: "10px",
              fontWeight: 600,
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
