import { useState } from "react";
import { sendInteractiveResponse } from "../../api/endpoints.js";
import type { InteractivePrompt } from "../../types/index.js";

interface InteractivePromptPanelProps {
  prompt: InteractivePrompt;
}

export function InteractivePromptPanel({ prompt }: InteractivePromptPanelProps) {
  const [sending, setSending] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string | string[]>>({});
  const [freeText, setFreeText] = useState("");

  const handleApprove = async () => {
    setSending(true);
    try {
      await sendInteractiveResponse(prompt.task_id, {
        promptType: prompt.promptType,
        approved: true,
      });
    } catch {
      // silently fail
    } finally {
      setSending(false);
    }
  };

  const handleReject = async () => {
    setSending(true);
    try {
      await sendInteractiveResponse(prompt.task_id, {
        promptType: prompt.promptType,
        approved: false,
        freeText: rejectFeedback || undefined,
      });
    } catch {
      // silently fail
    } finally {
      setSending(false);
    }
  };

  const handleSubmitAnswer = async () => {
    setSending(true);
    try {
      await sendInteractiveResponse(prompt.task_id, {
        promptType: prompt.promptType,
        selectedOptions: Object.keys(selectedOptions).length > 0 ? selectedOptions : undefined,
        freeText: freeText || undefined,
      });
    } catch {
      // silently fail
    } finally {
      setSending(false);
    }
  };

  const toggleOption = (question: string, label: string, multiSelect: boolean) => {
    setSelectedOptions((prev) => {
      const current = prev[question];
      if (multiSelect) {
        const arr = Array.isArray(current) ? current : [];
        const next = arr.includes(label) ? arr.filter((v) => v !== label) : [...arr, label];
        return { ...prev, [question]: next };
      }
      return { ...prev, [question]: label };
    });
  };

  const inputStyle = {
    width: "100%",
    background: "var(--bg-tertiary)",
    border: "1px solid var(--border-default)",
    borderRadius: "6px",
    padding: "8px 12px",
    fontSize: "13px",
    color: "var(--text-primary)",
    resize: "none" as const,
    outline: "none",
  };

  const answerInputStyle = {
    ...inputStyle,
    background: "var(--bg-secondary)",
    border: "1px solid var(--accent-primary)",
    boxShadow: "0 0 0 3px var(--accent-subtle), var(--shadow-sm)",
  };

  const inputAreaStyle = {
    background: "var(--bg-secondary)",
    border: "1px solid var(--accent-primary)",
    borderRadius: "8px",
    padding: "10px",
    boxShadow: "var(--shadow-sm)",
  };

  if (prompt.promptType === "exit_plan_mode") {
    return (
      <div style={{
        border: "1px solid var(--status-progress)",
        borderRadius: "8px",
        padding: "16px",
        background: "var(--bg-tertiary)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--status-progress)" }} />
          <h3 style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
            Plan Approval Required
          </h3>
        </div>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "16px" }}>
          The agent has created a plan and is waiting for your approval before proceeding with implementation.
        </p>

        {!showRejectForm ? (
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={handleApprove}
              disabled={sending}
              className="eb-btn eb-btn--primary"
              style={{ opacity: sending ? 0.5 : 1 }}
            >
              {sending ? "..." : "Approve"}
            </button>
            <button
              onClick={() => setShowRejectForm(true)}
              disabled={sending}
              className="eb-btn eb-btn--danger"
              style={{ opacity: sending ? 0.5 : 1 }}
            >
              Reject
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <textarea
              value={rejectFeedback}
              onChange={(e) => setRejectFeedback(e.target.value)}
              placeholder="Optional: provide feedback on what to change..."
              style={{ ...inputStyle, height: "80px" }}
            />
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={handleReject}
                disabled={sending}
                className="eb-btn eb-btn--danger"
                style={{ opacity: sending ? 0.5 : 1 }}
              >
                {sending ? "..." : "Reject with Feedback"}
              </button>
              <button
                onClick={() => setShowRejectForm(false)}
                className="eb-btn"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // text_input_request
  if (prompt.promptType === "text_input_request") {
    const detectedText = prompt.detectedText || prompt.questions?.[0]?.question || "";
    return (
      <div style={{
        border: "1px solid var(--status-done)",
        borderRadius: "8px",
        padding: "16px",
        background: "var(--accent-subtle)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--status-done)" }} />
          <h3 style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
            Input Required
          </h3>
        </div>
        {detectedText && (
          <p style={{ fontSize: "13px", color: "var(--text-primary)", marginBottom: "12px", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
            {detectedText}
          </p>
        )}
        <div style={{ ...inputAreaStyle, marginBottom: "8px" }}>
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Type your response..."
            className="interactive-answer-input"
            style={{ ...answerInputStyle, height: "96px" }}
          />
        </div>
        <button
          onClick={handleSubmitAnswer}
          disabled={sending || !freeText.trim()}
          className="eb-btn eb-btn--primary"
          style={{ opacity: (sending || !freeText.trim()) ? 0.5 : 1 }}
        >
          {sending ? "..." : "Send Response"}
        </button>
      </div>
    );
  }

  // ask_user_question
  const questions = prompt.questions ?? [];
  const hasOptions = questions.some((q) => q.options && q.options.length > 0);
  const hasAnswer = Object.keys(selectedOptions).length > 0 || freeText.trim().length > 0;

  return (
    <div style={{
      border: "1px solid var(--accent-primary)",
      borderRadius: "8px",
      padding: "16px",
      background: "var(--accent-subtle)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
        <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent-primary)" }} />
        <h3 style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
          Agent Question
        </h3>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {questions.map((q, qi) => (
          <div key={qi}>
            {q.header && (
              <span style={{
                display: "inline-block",
                fontSize: "10px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--accent-primary)",
                background: "var(--accent-subtle)",
                padding: "2px 6px",
                borderRadius: "3px",
                marginBottom: "4px",
              }}>
                {q.header}
              </span>
            )}
            <p style={{ fontSize: "13px", color: "var(--text-primary)", marginBottom: "8px", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{q.question}</p>
            {q.options && q.options.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {q.options.map((opt, oi) => {
                  const selected = q.multiSelect
                    ? (Array.isArray(selectedOptions[q.question]) && (selectedOptions[q.question] as string[]).includes(opt.label))
                    : selectedOptions[q.question] === opt.label;
                  return (
                    <button
                      key={oi}
                      onClick={() => toggleOption(q.question, opt.label, !!q.multiSelect)}
                      style={{
                        textAlign: "left",
                        padding: "8px 12px",
                        borderRadius: "6px",
                        border: `1px solid ${selected ? "var(--accent-primary)" : "var(--border-default)"}`,
                        fontSize: "13px",
                        cursor: "pointer",
                        transition: "border-color 0.15s, background 0.15s",
                        background: selected ? "var(--accent-subtle)" : "var(--bg-secondary)",
                        color: selected ? "var(--text-primary)" : "var(--text-secondary)",
                      }}
                    >
                      <div style={{ fontWeight: 500 }}>{opt.label}</div>
                      {opt.description && (
                        <div style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "2px" }}>{opt.description}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ ...inputAreaStyle, marginTop: "12px" }}>
        <textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder={hasOptions ? "Or type a custom answer..." : "Type your answer..."}
          className="interactive-answer-input"
          style={{ ...answerInputStyle, height: "80px" }}
        />
      </div>

      <div style={{ marginTop: "8px" }}>
        <button
          onClick={handleSubmitAnswer}
          disabled={sending || !hasAnswer}
          className="eb-btn eb-btn--primary"
          style={{ opacity: (sending || !hasAnswer) ? 0.5 : 1 }}
        >
          {sending ? "..." : "Submit Answer"}
        </button>
      </div>
    </div>
  );
}
