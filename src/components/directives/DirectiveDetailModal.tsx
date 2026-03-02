import { useState, useEffect, useRef } from "react";
import type { Directive, Task, WSEventType } from "../../types/index.js";
import { decomposeDirective as triggerDecompose, fetchDirectivePlan, fetchDecomposeLogs } from "../../api/endpoints.js";
import type { DecomposeLogEntry } from "../../api/endpoints.js";

type WsOnFn = (type: WSEventType, fn: (payload: unknown) => void) => () => void;

const LOG_KIND_COLORS: Record<string, string> = {
  stdout: "text-green-400",
  stderr: "text-red-400",
  system: "text-yellow-400",
};

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

function parseDependsOn(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sortByTaskNumber(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.task_number && b.task_number) return a.task_number.localeCompare(b.task_number);
    if (a.task_number) return -1;
    if (b.task_number) return 1;
    return 0;
  });
}

type TabView = "tasks" | "plan";

function DecomposeLogView({ directiveId, onWsEvent }: { directiveId: string; onWsEvent: WsOnFn }) {
  const [logs, setLogs] = useState<DecomposeLogEntry[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch buffered logs on mount
  useEffect(() => {
    fetchDecomposeLogs(directiveId)
      .then((buffered) => setLogs(buffered))
      .catch(() => { /* no buffered logs */ });
  }, [directiveId]);

  // Subscribe to real-time updates
  useEffect(() => {
    return onWsEvent("decompose_output", (payload) => {
      const entry = payload as DecomposeLogEntry;
      if (entry.directive_id !== directiveId) return;
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
    });
  }, [directiveId, onWsEvent]);

  // Auto-scroll
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div
      ref={containerRef}
      className="bg-gray-900 rounded-lg p-3 font-mono text-xs leading-relaxed overflow-y-auto max-h-48 border border-gray-700"
    >
      {logs.length === 0 ? (
        <div className="flex items-center gap-2 text-yellow-400">
          <span className="animate-spin">&#9696;</span>
          Waiting for output...
        </div>
      ) : (
        logs.map((log, i) => (
          <div key={i} className={`${LOG_KIND_COLORS[log.kind] ?? "text-gray-400"} whitespace-pre-wrap break-all`}>
            {log.message}
          </div>
        ))
      )}
    </div>
  );
}

interface DirectiveDetailModalProps {
  directive: Directive;
  tasks: Task[];
  onClose: () => void;
  onReload: () => void;
  onWsEvent: WsOnFn;
}

export function DirectiveDetailModal({ directive, tasks, onClose, onReload, onWsEvent }: DirectiveDetailModalProps) {
  const linkedTasks = sortByTaskNumber(tasks.filter((t) => t.directive_id === directive.id));
  const status = STATUS_STYLES[directive.status] ?? { label: directive.status, color: "bg-gray-600" };
  const doneCount = linkedTasks.filter((t) => t.status === "done").length;
  const progress = linkedTasks.length > 0 ? Math.round((doneCount / linkedTasks.length) * 100) : 0;

  const [activeTab, setActiveTab] = useState<TabView>("tasks");
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState(false);

  useEffect(() => {
    if (activeTab === "plan" && planContent === null && !planLoading) {
      setPlanLoading(true);
      setPlanError(false);
      fetchDirectivePlan(directive.id)
        .then((res) => setPlanContent(res.content))
        .catch(() => setPlanError(true))
        .finally(() => setPlanLoading(false));
    }
  }, [activeTab, directive.id, planContent, planLoading]);

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

          {/* Tabs: Tasks / Plan */}
          {linkedTasks.length > 0 && (
            <div className="mb-3 flex gap-1 border-b border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setActiveTab("tasks")}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${activeTab === "tasks" ? "border-b-2 border-blue-500 text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"}`}
              >
                Tasks ({linkedTasks.length})
              </button>
              <button
                onClick={() => setActiveTab("plan")}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${activeTab === "plan" ? "border-b-2 border-blue-500 text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"}`}
              >
                Plan
              </button>
            </div>
          )}

          {/* Tasks tab */}
          {activeTab === "tasks" && linkedTasks.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {linkedTasks.map((t) => {
                const deps = parseDependsOn(t.depends_on);
                return (
                  <div
                    key={t.id}
                    className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-sm"
                  >
                    <div className="flex-1 min-w-0 mr-2">
                      <div className="flex items-center gap-1.5">
                        {t.task_number && (
                          <span className="text-blue-500 font-mono text-xs font-bold shrink-0">{t.task_number}</span>
                        )}
                        <span className="text-gray-800 dark:text-gray-200 truncate">{t.title}</span>
                      </div>
                      {deps.length > 0 && (
                        <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                          &larr; depends on: {deps.join(", ")}
                        </div>
                      )}
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium shrink-0 ${TASK_STATUS_COLORS[t.status] ?? "bg-gray-200 text-gray-600"}`}>
                      {t.status.replace("_", " ")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Plan tab */}
          {activeTab === "plan" && (
            <div>
              {planLoading && (
                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                  <span className="animate-spin">&#9696;</span>
                  Loading plan...
                </div>
              )}
              {planError && (
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  No plan available for this directive.
                </div>
              )}
              {planContent && (
                <pre className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700 overflow-x-auto">
                  {planContent}
                </pre>
              )}
            </div>
          )}

          {directive.status === "decomposing" && (
            <div className="mt-2">
              <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                Decompose Output
              </h3>
              <DecomposeLogView directiveId={directive.id} onWsEvent={onWsEvent} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
