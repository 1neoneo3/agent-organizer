import { useState } from "react";
import { CreateDirectiveModal } from "./CreateDirectiveModal.js";
import { DirectiveDetailModal } from "./DirectiveDetailModal.js";
import { createDirective } from "../../api/endpoints.js";
import type { Directive, Task } from "../../types/index.js";

const STATUS_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "Pending", color: "text-gray-600 dark:text-gray-400", bg: "bg-gray-100 dark:bg-gray-800" },
  decomposing: { label: "Decomposing", color: "text-yellow-600 dark:text-yellow-400", bg: "bg-yellow-50 dark:bg-yellow-900/20" },
  active: { label: "Active", color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-900/20" },
  completed: { label: "Completed", color: "text-green-600 dark:text-green-400", bg: "bg-green-50 dark:bg-green-900/20" },
  cancelled: { label: "Cancelled", color: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-900/20" },
};

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface DirectivesPageProps {
  directives: Directive[];
  tasks: Task[];
  onReload: () => void;
}

export function DirectivesPage({ directives, tasks, onReload }: DirectivesPageProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleCreate = async (data: Parameters<typeof createDirective>[0]) => {
    await createDirective(data);
    setShowCreate(false);
    onReload();
  };

  const selectedDirective = directives.find((d) => d.id === selectedId);

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Directives</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
        >
          + New Directive
        </button>
      </div>

      {directives.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-gray-500">
          <p className="text-lg mb-2">No directives yet</p>
          <p className="text-sm mb-4">Create a directive to auto-generate tasks</p>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
          >
            + Create First Directive
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {directives.map((d) => {
            const linkedTasks = tasks.filter((t) => t.directive_id === d.id);
            const doneCount = linkedTasks.filter((t) => t.status === "done").length;
            const style = STATUS_STYLES[d.status] ?? STATUS_STYLES.pending;

            return (
              <div
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={`${style.bg} rounded-lg p-4 cursor-pointer hover:opacity-80 transition-opacity border border-gray-200 dark:border-gray-700`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{d.title}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{d.content}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`text-xs font-medium ${style.color}`}>{style.label}</span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">{formatTimestamp(d.created_at)}</span>
                  </div>
                </div>
                {linkedTasks.length > 0 && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                      <div
                        className="bg-green-500 h-1.5 rounded-full transition-all"
                        style={{ width: `${linkedTasks.length > 0 ? (doneCount / linkedTasks.length) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-500 dark:text-gray-400 shrink-0">
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
        />
      )}
    </div>
  );
}
