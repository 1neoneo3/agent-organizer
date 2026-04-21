import { useEffect, useRef, useState } from "react";
import { sendInteractiveResponse } from "../../api/endpoints.js";
import type { InteractivePrompt } from "../../types/index.js";

interface ToastItem {
  prompt: InteractivePrompt;
  taskTitle: string;
  visible: boolean;
  /** Whether the inline reply form is expanded */
  expanded: boolean;
}

interface InteractivePromptToastProps {
  interactivePrompts: Map<string, InteractivePrompt>;
  tasks: Array<{ id: string; title: string }>;
  onNavigateToTask: (taskId: string) => void;
}

function getPromptLabel(promptType: string): string {
  switch (promptType) {
    case "exit_plan_mode": return "Plan Approval";
    case "text_input_request": return "Input Required";
    default: return "Agent Question";
  }
}

function getPromptColorClass(promptType: string): { bg: string; border: string; dot: string; text: string } {
  if (promptType === "exit_plan_mode") {
    return {
      bg: "bg-amber-50 dark:bg-amber-950",
      border: "border-amber-400 dark:border-amber-500",
      dot: "bg-amber-400",
      text: "text-amber-800 dark:text-amber-300",
    };
  }
  if (promptType === "text_input_request") {
    return {
      bg: "bg-emerald-50 dark:bg-emerald-950",
      border: "border-emerald-400 dark:border-emerald-500",
      dot: "bg-emerald-400",
      text: "text-emerald-800 dark:text-emerald-300",
    };
  }
  return {
    bg: "bg-blue-50 dark:bg-blue-950",
    border: "border-blue-400 dark:border-blue-500",
    dot: "bg-blue-400",
    text: "text-blue-800 dark:text-blue-300",
  };
}

function InlineReplyForm({ prompt, onDismiss }: { prompt: InteractivePrompt; onDismiss: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await sendInteractiveResponse(prompt.task_id, {
        promptType: prompt.promptType,
        freeText: text.trim(),
      });
      onDismiss();
    } catch {
      // silently fail
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            handleSend();
          }
        }}
        placeholder="Type your response..."
        className="w-full bg-white dark:bg-gray-800 rounded-md px-3 py-2 text-sm min-h-24 resize-y border border-emerald-500/70 dark:border-emerald-400/70 shadow-inner focus:outline-none focus:ring-2 focus:ring-emerald-500"
      />
      <div className="flex justify-end gap-2 mt-1.5">
        <button
          onClick={handleSend}
          disabled={!text.trim() || sending}
          className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-colors disabled:opacity-50"
        >
          {sending ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}

export function InteractivePromptToast({ interactivePrompts, tasks, onNavigateToTask }: InteractivePromptToastProps) {
  const [toasts, setToasts] = useState<Map<string, ToastItem>>(new Map());

  // Show new toasts when interactive prompts arrive
  useEffect(() => {
    for (const [taskId, prompt] of interactivePrompts) {
      if (!toasts.has(taskId)) {
        const task = tasks.find((t) => t.id === taskId);
        setToasts((prev) => {
          const next = new Map(prev);
          next.set(taskId, {
            prompt,
            taskTitle: task?.title ?? "Unknown task",
            visible: true,
            expanded: prompt.promptType === "text_input_request",
          });
          return next;
        });
      }
    }
    // Remove toasts for resolved prompts
    for (const taskId of toasts.keys()) {
      if (!interactivePrompts.has(taskId)) {
        setToasts((prev) => {
          const next = new Map(prev);
          next.delete(taskId);
          return next;
        });
      }
    }
  }, [interactivePrompts, tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = (taskId: string) => {
    setToasts((prev) => {
      const next = new Map(prev);
      const item = next.get(taskId);
      if (item) next.set(taskId, { ...item, visible: false });
      return next;
    });
  };

  const toggleExpand = (taskId: string) => {
    setToasts((prev) => {
      const next = new Map(prev);
      const item = next.get(taskId);
      if (item) next.set(taskId, { ...item, expanded: !item.expanded });
      return next;
    });
  };

  const handleClick = (taskId: string, item: ToastItem) => {
    // For text_input_request, toggle the inline form instead of navigating
    if (item.prompt.promptType === "text_input_request") {
      toggleExpand(taskId);
      return;
    }
    dismiss(taskId);
    onNavigateToTask(taskId);
  };

  const visibleToasts = [...toasts.entries()].filter(([, item]) => item.visible);
  if (visibleToasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[100] flex w-[min(92vw,680px)] max-h-[calc(100vh-2rem)] flex-col gap-2 overflow-y-auto">
      {visibleToasts.map(([taskId, item]) => {
        const colors = getPromptColorClass(item.prompt.promptType);
        const detectedText = item.prompt.detectedText || item.prompt.questions?.[0]?.question;

        return (
          <div
            key={taskId}
            className={`rounded-lg shadow-lg border-l-4 p-4 cursor-pointer transition-all animate-slide-in ${colors.bg} ${colors.border}`}
            onClick={() => handleClick(taskId, item)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`inline-block w-2 h-2 rounded-full animate-pulse ${colors.dot}`} />
                  <span className={`text-xs font-bold ${colors.text}`}>
                    {getPromptLabel(item.prompt.promptType)}
                  </span>
                </div>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200 break-words">
                  {item.taskTitle}
                </p>
                {detectedText && (
                  <p className="text-xs leading-relaxed text-gray-700 dark:text-gray-300 mt-2 whitespace-pre-wrap break-words max-h-72 overflow-y-auto pr-1">
                    {detectedText}
                  </p>
                )}
                {!item.expanded && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {item.prompt.promptType === "text_input_request" ? "Click to reply" : "Click to respond"}
                  </p>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dismiss(taskId);
                }}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm leading-none p-0.5"
              >
                ✕
              </button>
            </div>
            {item.expanded && item.prompt.promptType === "text_input_request" && (
              <InlineReplyForm prompt={item.prompt} onDismiss={() => dismiss(taskId)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
