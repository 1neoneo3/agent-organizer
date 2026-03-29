import { useState, useEffect, useRef } from "react";
import type { Directive, Task, WSEventType } from "../../types/index.js";
import { decomposeDirective as triggerDecompose, fetchDirectivePlan, fetchDecomposeLogs } from "../../api/endpoints.js";
import type { DecomposeLogEntry } from "../../api/endpoints.js";

type WsOnFn = (type: WSEventType, fn: (payload: unknown) => void) => () => void;

const LOG_KIND_COLORS: Record<string, string> = {
  stdout: "#86efac",
  stderr: "#fca5a5",
  system: "#fde68a",
};

const STATUS_STYLES: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "var(--status-inbox)" },
  decomposing: { label: "Decomposing...", color: "var(--status-progress)" },
  active: { label: "Active", color: "var(--accent-primary)" },
  completed: { label: "Completed", color: "var(--status-done)" },
  cancelled: { label: "Cancelled", color: "var(--status-cancelled)" },
};

const TASK_STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  inbox: { color: "var(--status-inbox)", bg: "var(--bg-tertiary)" },
  in_progress: { color: "var(--status-progress)", bg: "var(--bg-tertiary)" },
  qa_testing: { color: "var(--status-qa)", bg: "var(--bg-tertiary)" },
  done: { color: "var(--status-done)", bg: "var(--bg-tertiary)" },
  cancelled: { color: "var(--status-cancelled)", bg: "var(--bg-tertiary)" },
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

  useEffect(() => {
    fetchDecomposeLogs(directiveId)
      .then((buffered) => setLogs(buffered))
      .catch(() => { /* no buffered logs */ });
  }, [directiveId]);

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

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div
      ref={containerRef}
      style={{
        background: "#0d0d0d",
        borderRadius: "6px",
        padding: "12px",
        fontFamily: "var(--font-mono)",
        fontSize: "12px",
        lineHeight: "1.6",
        overflowY: "auto",
        maxHeight: "192px",
        border: "1px solid var(--border-default)",
      }}
    >
      {logs.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--status-progress)" }}>
          Waiting for output...
        </div>
      ) : (
        logs.map((log, i) => (
          <div key={i} style={{ color: LOG_KIND_COLORS[log.kind] ?? "#a0a0a0", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
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
  const status = STATUS_STYLES[directive.status] ?? { label: directive.status, color: "var(--status-inbox)" };
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
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: "12px",
          width: "100%",
          maxWidth: "40rem",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", padding: "20px 24px 12px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>{directive.title}</h2>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" }}>
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
              <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                {formatTimestamp(directive.created_at)}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              color: "var(--text-tertiary)",
              fontSize: "16px",
              lineHeight: 1,
              padding: "4px",
              cursor: "pointer",
              background: "none",
              border: "none",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
          >
            &#x2715;
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 20px" }}>
          {/* Content */}
          <div style={{ marginBottom: "16px" }}>
            <h3 style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
              Content
            </h3>
            <div style={{
              fontSize: "13px",
              color: "var(--text-primary)",
              whiteSpace: "pre-wrap",
              background: "var(--bg-tertiary)",
              borderRadius: "8px",
              padding: "12px",
              border: "1px solid var(--border-subtle)",
            }}>
              {directive.content}
            </div>
          </div>

          {directive.project_path && (
            <div style={{ marginBottom: "16px", fontSize: "13px" }}>
              <span style={{ color: "var(--text-tertiary)" }}>Project: </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-primary)" }}>{directive.project_path}</span>
            </div>
          )}

          {/* Decompose button */}
          {directive.status === "pending" && (
            <div style={{ marginBottom: "16px" }}>
              <button
                onClick={handleDecompose}
                className="eb-btn eb-btn--primary"
              >
                Decompose into Tasks
              </button>
            </div>
          )}

          {/* Progress bar */}
          {linkedTasks.length > 0 && (
            <div style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px", color: "var(--text-tertiary)", marginBottom: "4px" }}>
                <span>Progress</span>
                <span>{doneCount}/{linkedTasks.length} tasks ({progress}%)</span>
              </div>
              <div style={{ width: "100%", background: "var(--bg-tertiary)", borderRadius: "4px", height: "6px" }}>
                <div
                  style={{
                    background: "var(--status-done)",
                    height: "6px",
                    borderRadius: "4px",
                    transition: "width 0.3s ease",
                    width: `${progress}%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Tabs */}
          {linkedTasks.length > 0 && (
            <div style={{ marginBottom: "12px", display: "flex", gap: "2px", borderBottom: "1px solid var(--border-default)" }}>
              <button
                onClick={() => setActiveTab("tasks")}
                style={{
                  padding: "6px 12px",
                  fontSize: "12px",
                  fontWeight: 500,
                  background: "none",
                  border: "none",
                  borderBottom: activeTab === "tasks" ? "2px solid var(--accent-primary)" : "2px solid transparent",
                  color: activeTab === "tasks" ? "var(--accent-primary)" : "var(--text-tertiary)",
                  cursor: "pointer",
                  transition: "color 0.15s",
                }}
              >
                Tasks ({linkedTasks.length})
              </button>
              <button
                onClick={() => setActiveTab("plan")}
                style={{
                  padding: "6px 12px",
                  fontSize: "12px",
                  fontWeight: 500,
                  background: "none",
                  border: "none",
                  borderBottom: activeTab === "plan" ? "2px solid var(--accent-primary)" : "2px solid transparent",
                  color: activeTab === "plan" ? "var(--accent-primary)" : "var(--text-tertiary)",
                  cursor: "pointer",
                  transition: "color 0.15s",
                }}
              >
                Plan
              </button>
            </div>
          )}

          {/* Tasks tab */}
          {activeTab === "tasks" && linkedTasks.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {linkedTasks.map((t) => {
                const deps = parseDependsOn(t.depends_on);
                const taskStatusStyle = TASK_STATUS_COLORS[t.status] ?? { color: "var(--text-secondary)", bg: "var(--bg-tertiary)" };
                return (
                  <div
                    key={t.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      background: "var(--bg-tertiary)",
                      border: "1px solid var(--border-subtle)",
                      fontSize: "13px",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0, marginRight: "8px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        {t.task_number && (
                          <span style={{ color: "var(--accent-primary)", fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 600, flexShrink: 0 }}>{t.task_number}</span>
                        )}
                        <span style={{ color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                      </div>
                      {deps.length > 0 && (
                        <div style={{ fontSize: "10px", color: "var(--text-tertiary)", marginTop: "2px" }}>
                          &larr; depends on: {deps.join(", ")}
                        </div>
                      )}
                    </div>
                    <span style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      fontSize: "10px",
                      fontWeight: 600,
                      color: taskStatusStyle.color,
                      background: taskStatusStyle.bg,
                      flexShrink: 0,
                    }}>
                      <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: taskStatusStyle.color }} />
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
                <div style={{ fontSize: "13px", color: "var(--text-tertiary)" }}>
                  Loading plan...
                </div>
              )}
              {planError && (
                <div style={{ fontSize: "13px", color: "var(--text-tertiary)" }}>
                  No plan available for this directive.
                </div>
              )}
              {planContent && (
                <pre style={{
                  fontSize: "13px",
                  color: "var(--text-primary)",
                  whiteSpace: "pre-wrap",
                  background: "var(--bg-tertiary)",
                  borderRadius: "8px",
                  padding: "12px",
                  border: "1px solid var(--border-subtle)",
                  overflowX: "auto",
                  fontFamily: "var(--font-mono)",
                }}>
                  {planContent}
                </pre>
              )}
            </div>
          )}

          {directive.status === "decomposing" && (
            <div style={{ marginTop: "8px" }}>
              <h3 style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
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
