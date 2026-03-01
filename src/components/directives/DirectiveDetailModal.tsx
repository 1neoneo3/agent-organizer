import type { Directive, Task } from "../../types/index.js";
import { decomposeDirective as triggerDecompose } from "../../api/endpoints.js";

const STATUS_STYLES: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "bg-gray-600" },
  decomposing: { label: "Decomposing...", color: "bg-yellow-600" },
  active: { label: "Active", color: "bg-blue-600" },
  completed: { label: "Completed", color: "bg-green-600" },
  cancelled: { label: "Cancelled", color: "bg-red-600" },
};

const TASK_STATUS_COLORS: Record<string, string> = {
  inbox: "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  done: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
};

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface DirectiveDetailModalProps {
  directive: Directive;
  tasks: Task[];
  onClose: () => void;
  onReload: () => void;
}

export function DirectiveDetailModal({ directive, tasks, onClose, onReload }: DirectiveDetailModalProps) {
  const linkedTasks = tasks.filter((t) => t.directive_id === directive.id);
  const status = STATUS_STYLES[directive.status] ?? { label: directive.status, color: "bg-gray-600" };
  const doneCount = linkedTasks.filter((t) => t.status === "done").length;
  const progress = linkedTasks.length > 0 ? Math.round((doneCount / linkedTasks.length) * 100) : 0;

  const handleDecompose = async () => {
    try {
      await triggerDecompose(directive.id);
      onReload();
    } catch (err) {
      console.error("Decompose failed:", err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col border border-gray-200 dark:border-gray-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{directive.title}</h2>
            <div className="flex items-center gap-2 mt-2">
              <span className={`px-2 py-0.5 rounded text-xs font-medium text-white ${status.color}`}>
                {status.label}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {formatTimestamp(directive.created_at)}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none p-1"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {/* Content */}
          <div className="mb-4">
            <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
              Content
            </h3>
            <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
              {directive.content}
            </div>
          </div>

          {directive.project_path && (
            <div className="mb-4 text-sm">
              <span className="text-gray-500 dark:text-gray-400">Project: </span>
              <span className="font-mono text-xs text-gray-800 dark:text-gray-200">{directive.project_path}</span>
            </div>
          )}

          {/* Decompose button */}
          {directive.status === "pending" && (
            <div className="mb-4">
              <button
                onClick={handleDecompose}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
              >
                Decompose into Tasks
              </button>
            </div>
          )}

          {/* Progress bar */}
          {linkedTasks.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                <span>Progress</span>
                <span>{doneCount}/{linkedTasks.length} tasks ({progress}%)</span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div
                  className="bg-green-500 h-2 rounded-full transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Linked tasks */}
          {linkedTasks.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                Tasks ({linkedTasks.length})
              </h3>
              <div className="flex flex-col gap-1.5">
                {linkedTasks.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-sm"
                  >
                    <span className="text-gray-800 dark:text-gray-200 truncate mr-2">{t.title}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium shrink-0 ${TASK_STATUS_COLORS[t.status] ?? "bg-gray-200 text-gray-600"}`}>
                      {t.status.replace("_", " ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {directive.status === "decomposing" && (
            <div className="flex items-center gap-2 text-sm text-yellow-600 dark:text-yellow-400 mt-2">
              <span className="animate-spin">&#9696;</span>
              Decomposing directive into tasks...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
