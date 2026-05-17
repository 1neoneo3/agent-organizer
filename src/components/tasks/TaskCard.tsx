import { memo, useState, useRef, useEffect } from "react";
import { PixelAvatar } from "../../components/agents/PixelAvatar.js";
import { sendTaskFeedback, sendInteractiveResponse, approveTask, rejectTask } from "../../api/endpoints.js";
import { useSfx } from "../../hooks/useSfx.js";
import type { TaskSummary, Agent, InteractivePrompt } from "../../types/index.js";
import { formatRelativeTaskTime, formatTaskTimestamp } from "./task-relative-time.js";
import { formatModelName } from "../../formatModelName.js";
import { getResumeActionState } from "./task-resume.js";
import { getTaskFeedbackUi } from "./task-feedback-ui.js";
import { getTaskRevisionUi } from "./task-revision-ui.js";
import { getHumanReviewRunUi } from "./task-human-review-ui.js";
import type { TaskCardBlockers, TaskBlockerRef } from "./task-blockers.js";
import { formatControllerTaskTitle } from "./task-display.js";

const SIZE_LABEL: Record<string, string> = {
  small: "S",
  medium: "M",
  large: "L",
};

const STATUS_DISPLAY: Record<string, string> = {
  inbox: "Inbox",
  refinement: "Plan",
  in_progress: "In Progress",
  test_generation: "Test Gen",
  qa_testing: "QA Testing",
  pr_review: "PR Review",
  human_review: "Human Review",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<string, string> = {
  inbox: "var(--status-inbox)",
  refinement: "var(--status-refinement)",
  in_progress: "var(--status-progress)",
  test_generation: "var(--status-test-gen)",
  qa_testing: "var(--status-qa)",
  pr_review: "var(--status-review)",
  human_review: "var(--status-human-review)",
  done: "var(--status-done)",
  cancelled: "var(--status-cancelled)",
};

interface TaskCardProps {
  task: TaskSummary;
  blockers?: TaskCardBlockers;
  assignedAgent?: Agent;
  activeAgent?: Agent;
  idleAgents: Agent[];
  roleLabelByAgentId: Map<string, string>;
  hasInteractivePrompt?: boolean;
  interactivePrompt?: InteractivePrompt;
  onRun?: (taskId: string, agentId: string) => void;
  onStop?: (taskId: string) => void;
  onResume?: (taskId: string, agentId: string) => void;
  onDone?: (taskId: string) => void;
  onSelect?: (taskId: string) => void;
  onShowLog?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
}

function formatBlockerFiles(blocker: TaskBlockerRef): string | null {
  const files = blocker.overlappingFiles ?? [];
  if (files.length === 0) return null;
  const visible = files.slice(0, 2).join(", ");
  return files.length > 2 ? `${visible} +${files.length - 2}` : visible;
}

function BlockerLine({
  label,
  color,
  blockers,
}: {
  label: string;
  color: string;
  blockers: TaskBlockerRef[];
}) {
  if (blockers.length === 0) return null;
  return (
    <div style={{ fontSize: "10px", color: "var(--text-tertiary)", display: "flex", alignItems: "flex-start", gap: "4px", flexWrap: "wrap" }}>
      <span style={{ color, fontWeight: 600 }}>{label}</span>
      {blockers.map((blocker) => {
        const files = formatBlockerFiles(blocker);
        const title = [
          `${blocker.taskNumber} (${blocker.status})`,
          files ? `Files: ${(blocker.overlappingFiles ?? []).join(", ")}` : null,
        ].filter(Boolean).join("\n");
        return (
          <span
            key={`${blocker.kind}:${blocker.taskNumber}:${files ?? ""}`}
            title={title}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "3px",
              maxWidth: "100%",
              padding: "1px 5px",
              borderRadius: "4px",
              background: "var(--bg-tertiary)",
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <span>{blocker.taskNumber}</span>
            <span style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-sans)" }}>({blocker.status})</span>
            {files && (
              <span style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-sans)", overflow: "hidden", textOverflow: "ellipsis" }}>
                {files}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function formatParentStep(task: TaskSummary): string | null {
  if (typeof task.split_index !== "number") return null;
  if (typeof task.split_total !== "number") return `Step ${task.split_index}`;
  return `Step ${task.split_index}/${task.split_total}`;
}

function TaskCardInner({ task, blockers, assignedAgent, activeAgent, idleAgents, roleLabelByAgentId, hasInteractivePrompt, interactivePrompt, onRun, onStop, onResume, onDone, onSelect, onShowLog, onDelete }: TaskCardProps) {
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
  const createdAtLabel = formatRelativeTaskTime(task.created_at);
  const createdAtTooltip = formatTaskTimestamp(task.created_at);
  const feedbackUi = getTaskFeedbackUi(task.status);
  const { revisionBadge, planBanner } = getTaskRevisionUi(task);
  const activeHumanReviewAgent =
    activeAgent && activeAgent.id !== task.assigned_agent_id ? activeAgent : null;
  const humanReviewRunUi = getHumanReviewRunUi(task, activeHumanReviewAgent);
  const displayTitle = formatControllerTaskTitle(task);

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
      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "13px", lineHeight: "1.4", color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>
            {task.task_number && (
              <span style={{ color: "var(--text-secondary)", marginRight: "4px", fontSize: "11px", fontWeight: 600, fontFamily: "var(--font-mono)" }}>{task.task_number}</span>
            )}
            <span style={{ wordBreak: "break-word" }}>{displayTitle}</span>
          </div>
          {/* Parent/child relationship + blocker display.
              parent_task_number / child_task_numbers are server-derived
              fields populated from description/result heads — the
              regex extraction lives in server/domain/task-derived-fields.ts
              so the kanban does not need the full description/result
              columns shipped to the client. Blockers are computed from
              current task summaries so the card reflects dependencies and
              file conflicts without parsing dispatch log text. */}
          {(() => {
            const parentStep = formatParentStep(task);
            const hasParentInfo = Boolean(task.parent_task_number);
            const parentAccent = "var(--status-qa)";
            const childLine = task.child_task_numbers && task.child_task_numbers.length > 0
              ? { label: "Children", color: "var(--status-refinement)", values: task.child_task_numbers }
              : null;
            const hasBlockingInfo = (blockers?.dependencies.length ?? 0) > 0 || (blockers?.fileConflicts.length ?? 0) > 0;
            if (!hasParentInfo && !childLine && !hasBlockingInfo) return null;
            return (
              <div style={{ marginTop: "4px", display: "flex", flexDirection: "column", gap: "4px" }}>
                {hasParentInfo && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      flexWrap: "wrap",
                      padding: "5px 6px",
                      border: `1px solid color-mix(in srgb, ${parentAccent} 42%, var(--border-default))`,
                      borderRadius: "6px",
                      background: `color-mix(in srgb, ${parentAccent} 12%, var(--bg-secondary))`,
                    }}
                  >
                    <span style={{ color: parentAccent, fontSize: "10px", fontWeight: 700 }}>Parent Task</span>
                    <button
                      type="button"
                      disabled={!task.parent_task_id}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (task.parent_task_id) onSelect?.(task.parent_task_id);
                      }}
                      title={task.parent_task_title ? `${task.parent_task_number} ${task.parent_task_title}` : task.parent_task_number ?? undefined}
                      style={{
                        appearance: "none",
                        border: 0,
                        padding: 0,
                        margin: 0,
                        background: "transparent",
                        color: "var(--text-primary)",
                        cursor: task.parent_task_id ? "pointer" : "default",
                        display: "inline-flex",
                        alignItems: "baseline",
                        gap: "4px",
                        minWidth: 0,
                        maxWidth: "100%",
                      }}
                    >
                      <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)", fontSize: "10px", fontWeight: 700 }}>{task.parent_task_number}</span>
                      {task.parent_task_title && (
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "11px", maxWidth: "150px" }}>
                          {task.parent_task_title}
                        </span>
                      )}
                    </button>
                    {parentStep && (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-tertiary)" }}>{parentStep}</span>
                    )}
                  </div>
                )}
                {childLine && (
                  <div style={{ fontSize: "10px", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
                    <span style={{ color: childLine.color, fontWeight: 600 }}>{childLine.label}</span>
                    {childLine.values.map((v) => (
                      <span key={v} style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{v}</span>
                    ))}
                  </div>
                )}
                <BlockerLine label="Blocked by" color="var(--status-cancelled)" blockers={blockers?.dependencies ?? []} />
                <BlockerLine label="File conflict" color="var(--status-cancelled)" blockers={blockers?.fileConflicts ?? []} />
              </div>
            );
          })()}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "4px", flexWrap: "wrap" }}>
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
          {revisionBadge && (
            <span style={{
              padding: "2px 6px",
              background: revisionBadge.background,
              color: revisionBadge.color,
              borderRadius: "4px",
              fontSize: "10px",
              fontWeight: 600,
            }}>
              {revisionBadge.label}
            </span>
          )}
          {humanReviewRunUi && (
            <span style={{
              padding: "2px 6px",
              background: humanReviewRunUi.badge.background,
              color: humanReviewRunUi.badge.color,
              borderRadius: "4px",
              fontSize: "10px",
              fontWeight: 600,
            }}>
              {humanReviewRunUi.badge.label}
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

      {/* Refinement Plan / revise status */}
      {planBanner && (
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
          <span style={{ fontSize: "11px", fontWeight: 600, color: planBanner.color }}>
            {planBanner.label}
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

      {/* Auto Human Review status */}
      {humanReviewRunUi && (
        <div
          style={{
            padding: "8px 12px",
            background: "var(--bg-tertiary)",
            borderTop: "1px solid var(--border-default)",
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          <span style={{ fontSize: "11px", fontWeight: 600, color: humanReviewRunUi.banner.color }}>
            {humanReviewRunUi.banner.label}
          </span>
          <span style={{ fontSize: "10px", color: "var(--text-secondary)", lineHeight: 1.4 }}>
            {humanReviewRunUi.banner.description}
          </span>
        </div>
      )}

      {/* Human Review Approval */}
      {task.status === "human_review" && !humanReviewRunUi && (
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
          {feedbackUi?.cardDescription && (
            <div style={{ fontSize: "10px", color: "var(--text-secondary)", marginBottom: "6px", lineHeight: 1.4 }}>
              {feedbackUi.cardDescription}
            </div>
          )}
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              onClick={async () => { play("confirm"); await approveTask(task.id); }}
              className="eb-btn eb-btn--primary"
              style={{ flex: 1, fontSize: "11px", padding: "5px 8px" }}
            >
              Approve
            </button>
            <button
              onClick={() => { play("select"); onSelect?.(task.id); }}
              className="eb-btn"
              style={{ flex: 1, fontSize: "11px", padding: "5px 8px" }}
            >
              {feedbackUi?.cardActionLabel ?? "Feedback"}
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

      {/* Auto-respawn status (parked task being retried) */}
      {task.status === "in_progress" && task.started_at === null && task.auto_respawn_count > 0 && (
        <div
          style={{
            padding: "6px 12px",
            background: "var(--bg-tertiary)",
            borderTop: "1px solid var(--border-default)",
            borderBottom: "1px solid var(--border-default)",
            textAlign: "center",
          }}
        >
          <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--status-progress)" }}>
            Resuming {task.auto_respawn_count}/3
          </span>
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
            {formatModelName(agent.cli_model)}
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

        {/* Cancelled: Restart row (agent selector when assigned agent is busy/missing) */}
        {task.status === "cancelled" && (() => {
          const { canUseAssigned, resumeAgentId, showSelector } = getResumeActionState(
            assignedAgent,
            idleAgents,
            selectedAgentId,
          );
          return (
            <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {showSelector && (
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
              )}
              <div style={{ display: "flex", gap: "4px" }}>
                <button
                  onClick={(e) => { e.stopPropagation(); if (resumeAgentId) { play("confirm"); onResume?.(task.id, resumeAgentId); } }}
                  disabled={!resumeAgentId}
                  title={canUseAssigned ? `Restart with ${assignedAgent!.name}` : "Restart"}
                  className="eb-btn eb-btn--primary"
                  style={{ flex: 1, fontSize: "11px", padding: "4px 8px", opacity: resumeAgentId ? 1 : 0.5 }}
                >
                  Restart
                </button>
              </div>
            </div>
          );
        })()}

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

        <div
          style={{
            marginTop: "8px",
            fontSize: "10px",
            color: "var(--text-tertiary)",
            borderTop: "1px solid var(--border-subtle, var(--border-default))",
            paddingTop: "6px",
          }}
          title={createdAtTooltip}
        >
          Created {createdAtLabel}
        </div>
      </div>
    </div>
  );
}

function areTaskCardPropsEqual(prev: TaskCardProps, next: TaskCardProps): boolean {
  return prev.task === next.task
    && prev.blockers === next.blockers
    && prev.assignedAgent === next.assignedAgent
    && prev.idleAgents === next.idleAgents
    && prev.hasInteractivePrompt === next.hasInteractivePrompt
    && prev.interactivePrompt === next.interactivePrompt
    && prev.onRun === next.onRun
    && prev.onStop === next.onStop
    && prev.onResume === next.onResume
    && prev.onDone === next.onDone
    && prev.onSelect === next.onSelect
    && prev.onShowLog === next.onShowLog
    && prev.onDelete === next.onDelete
    && prev.roleLabelByAgentId === next.roleLabelByAgentId;
}

export const TaskCard = memo(TaskCardInner, areTaskCardPropsEqual);
