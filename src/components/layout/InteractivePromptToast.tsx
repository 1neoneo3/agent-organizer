import { useEffect, useState } from "react";
import type { InteractivePrompt } from "../../types/index.js";

interface ToastItem {
  prompt: InteractivePrompt;
  taskTitle: string;
  visible: boolean;
}

interface InteractivePromptToastProps {
  interactivePrompts: Map<string, InteractivePrompt>;
  tasks: Array<{ id: string; title: string }>;
  onNavigateToTask: (taskId: string) => void;
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

  const handleClick = (taskId: string) => {
    dismiss(taskId);
    onNavigateToTask(taskId);
  };

  const visibleToasts = [...toasts.entries()].filter(([, item]) => item.visible);
  if (visibleToasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {visibleToasts.map(([taskId, item]) => (
        <div
          key={taskId}
          className={`rounded-lg shadow-lg border-l-4 p-3 cursor-pointer transition-all animate-slide-in ${
            item.prompt.promptType === "exit_plan_mode"
              ? "bg-amber-50 dark:bg-amber-950 border-amber-400 dark:border-amber-500"
              : "bg-blue-50 dark:bg-blue-950 border-blue-400 dark:border-blue-500"
          }`}
          onClick={() => handleClick(taskId)}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`inline-block w-2 h-2 rounded-full animate-pulse ${
                  item.prompt.promptType === "exit_plan_mode" ? "bg-amber-400" : "bg-blue-400"
                }`} />
                <span className={`text-xs font-bold ${
                  item.prompt.promptType === "exit_plan_mode"
                    ? "text-amber-800 dark:text-amber-300"
                    : "text-blue-800 dark:text-blue-300"
                }`}>
                  {item.prompt.promptType === "exit_plan_mode" ? "Plan Approval" : "Agent Question"}
                </span>
              </div>
              <p className="text-sm text-gray-800 dark:text-gray-200 truncate">
                {item.taskTitle}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Click to respond
              </p>
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
        </div>
      ))}
    </div>
  );
}
