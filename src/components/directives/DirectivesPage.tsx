import { useState } from "react";
import { CreateDirectiveModal } from "./CreateDirectiveModal.js";
import { DirectiveDetailModal } from "./DirectiveDetailModal.js";
import { createDirective } from "../../api/endpoints.js";
import type { Directive, Task } from "../../types/index.js";

const STATUS_STYLES: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "var(--status-inbox)" },
  decomposing: { label: "Decomposing", color: "var(--status-progress)" },
  active: { label: "Active", color: "var(--accent-primary)" },
  completed: { label: "Completed", color: "var(--status-done)" },
  cancelled: { label: "Cancelled", color: "var(--status-cancelled)" },
};

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

import type { WSEventType } from "../../types/index.js";

type WsOnFn = (type: WSEventType, fn: (payload: unknown) => void) => () => void;

interface DirectivesPageProps {
  directives: Directive[];
  tasks: Task[];
  onReload: () => void;
  onWsEvent: WsOnFn;
}

export function DirectivesPage({ directives, tasks, onReload, onWsEvent }: DirectivesPageProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleCreate = async (data: Parameters<typeof createDirective>[0]) => {
    await createDirective(data);
    setShowCreate(false);
    onReload();
  };

  const selectedDirective = directives.find((d) => d.id === selectedId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: "18px", fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Directives</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="eb-btn eb-btn--primary"
        >
          + New Directive
        </button>
      </div>

      {directives.length === 0 ? (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "64px 0",
          color: "var(--text-tertiary)",
        }}>
          <p style={{ fontSize: "16px", fontWeight: 500, marginBottom: "8px", color: "var(--text-secondary)" }}>No directives yet</p>
          <p style={{ fontSize: "13px", marginBottom: "20px" }}>Create a directive to auto-generate tasks</p>
          <button
            onClick={() => setShowCreate(true)}
            className="eb-btn eb-btn--primary"
          >
            + Create First Directive
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {directives.map((d) => {
            const linkedTasks = tasks.filter((t) => t.directive_id === d.id);
            const doneCount = linkedTasks.filter((t) => t.status === "done").length;
            const style = STATUS_STYLES[d.status] ?? STATUS_STYLES.pending;

            return (
              <div
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                style={{
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "8px",
                  padding: "14px 16px",
                  cursor: "pointer",
                  transition: "border-color 0.15s ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--text-tertiary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3 style={{ fontSize: "14px", fontWeight: 500, color: "var(--text-primary)", margin: 0 }}>{d.title}</h3>
                    <p style={{
                      fontSize: "12px",
                      color: "var(--text-tertiary)",
                      marginTop: "4px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical" as const,
                    }}>{d.content}</p>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", flexShrink: 0 }}>
                    <span style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      fontSize: "11px",
                      fontWeight: 600,
                      color: style.color,
                    }}>
                      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: style.color }} />
                      {style.label}
                    </span>
                    <span style={{ fontSize: "10px", color: "var(--text-tertiary)" }}>{formatTimestamp(d.created_at)}</span>
                  </div>
                </div>
                {linkedTasks.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" }}>
                    <div style={{ flex: 1, background: "var(--bg-tertiary)", borderRadius: "4px", height: "4px" }}>
                      <div
                        style={{
                          background: "var(--status-done)",
                          height: "4px",
                          borderRadius: "4px",
                          transition: "width 0.3s ease",
                          width: `${linkedTasks.length > 0 ? (doneCount / linkedTasks.length) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <span style={{ fontSize: "10px", color: "var(--text-tertiary)", flexShrink: 0 }}>
                      {doneCount}/{linkedTasks.length}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <CreateDirectiveModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}

      {selectedDirective && (
        <DirectiveDetailModal
          directive={selectedDirective}
          tasks={tasks}
          onClose={() => setSelectedId(null)}
          onReload={onReload}
          onWsEvent={onWsEvent}
        />
      )}
    </div>
  );
}
