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

  if (prompt.promptType === "exit_plan_mode") {
    return (
      <div className="border-2 border-amber-400 dark:border-amber-500 rounded-lg p-4 bg-amber-50 dark:bg-amber-950/30">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <h3 className="text-sm font-bold text-amber-800 dark:text-amber-300">
            Plan Approval Required
          </h3>
        </div>
        <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
          The agent has created a plan and is waiting for your approval before proceeding with implementation.
        </p>

        {!showRejectForm ? (
          <div className="flex gap-2">
            <button
              onClick={handleApprove}
              disabled={sending}
              className="px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-500 text-white rounded transition-colors disabled:opacity-50"
            >
              {sending ? "..." : "Approve"}
            </button>
            <button
              onClick={() => setShowRejectForm(true)}
              disabled={sending}
              className="px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-500 text-white rounded transition-colors disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={rejectFeedback}
              onChange={(e) => setRejectFeedback(e.target.value)}
              placeholder="Optional: provide feedback on what to change..."
              className="w-full bg-white dark:bg-gray-800 rounded px-3 py-2 text-sm h-20 resize-none border border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
            <div className="flex gap-2">
              <button
                onClick={handleReject}
                disabled={sending}
                className="px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-500 text-white rounded transition-colors disabled:opacity-50"
              >
                {sending ? "..." : "Reject with Feedback"}
              </button>
              <button
                onClick={() => setShowRejectForm(false)}
                className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ask_user_question
  const questions = prompt.questions ?? [];
  const hasOptions = questions.some((q) => q.options && q.options.length > 0);
  const hasAnswer = Object.keys(selectedOptions).length > 0 || freeText.trim().length > 0;

  return (
    <div className="border-2 border-blue-400 dark:border-blue-500 rounded-lg p-4 bg-blue-50 dark:bg-blue-950/30">
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
        <h3 className="text-sm font-bold text-blue-800 dark:text-blue-300">
          Agent Question
        </h3>
      </div>

      <div className="space-y-4">
        {questions.map((q, qi) => (
          <div key={qi}>
            {q.header && (
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/50 px-1.5 py-0.5 rounded mb-1">
                {q.header}
              </span>
            )}
            <p className="text-sm text-gray-800 dark:text-gray-200 mb-2">{q.question}</p>
            {q.options && q.options.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {q.options.map((opt, oi) => {
                  const selected = q.multiSelect
                    ? (Array.isArray(selectedOptions[q.question]) && (selectedOptions[q.question] as string[]).includes(opt.label))
                    : selectedOptions[q.question] === opt.label;
                  return (
                    <button
                      key={oi}
                      onClick={() => toggleOption(q.question, opt.label, !!q.multiSelect)}
                      className={`text-left px-3 py-2 rounded border text-sm transition-colors ${
                        selected
                          ? "border-blue-500 bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200"
                          : "border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:border-blue-300 dark:hover:border-blue-600"
                      }`}
                    >
                      <div className="font-medium">{opt.label}</div>
                      {opt.description && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{opt.description}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3">
        <textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder={hasOptions ? "Or type a custom answer..." : "Type your answer..."}
          className="w-full bg-white dark:bg-gray-800 rounded px-3 py-2 text-sm h-16 resize-none border border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="mt-2">
        <button
          onClick={handleSubmitAnswer}
          disabled={sending || !hasAnswer}
          className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
        >
          {sending ? "..." : "Submit Answer"}
        </button>
      </div>
    </div>
  );
}
