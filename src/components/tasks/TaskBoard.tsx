import { memo, Profiler, useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { TaskCard } from "./TaskCard.js";
import { CreateTaskModal } from "./CreateTaskModal.js";
import { TaskDetailModal, PINNED_PANEL_WIDTH_PX, type TaskDetailLayoutMode } from "./TaskDetailModal.js";
import { TerminalPanel } from "../terminal/TerminalPanel.js";
import { createTask, runTask, stopTask, resumeTask, updateTask, deleteTask, createAgent, fetchTask } from "../../api/endpoints.js";
import { AgentForm, type AgentFormData } from "../agents/AgentForm.js";
import { getRoleLabel } from "../agents/roles.js";
import { PixelAvatar } from "../agents/PixelAvatar.js";
import { useSfx } from "../../hooks/useSfx.js";
import type { Task, TaskSummary, Agent, InteractivePrompt, WSEventType } from "../../types/index.js";
import { buildAgentViewState } from "./agent-view.js";
import { TASK_BOARD_COLUMNS, createEmptyTaskColumns, groupTasksByStatusStable, type TaskColumns } from "./task-columns.js";

interface TaskBoardProps {
  tasks: TaskSummary[];
  agents: Agent[];
  interactivePrompts: Map<string, InteractivePrompt>;
  onReload: () => void;
  onSubscribeTask?: (taskId: string) => () => void;
  onWsEvent: (type: WSEventType, fn: (payload: unknown) => void) => () => void;
}

interface TaskColumnProps {
  label: string;
  town: string;
  accentColor: string;
  tasks: TaskSummary[];
  assignedAgentById: Map<string, Agent>;
  idleAgents: Agent[];
  roleLabelByAgentId: Map<string, string>;
  interactivePrompts: Map<string, InteractivePrompt>;
  onRun: (taskId: string, agentId: string) => Promise<void>;
  onStop: (taskId: string) => Promise<void>;
  onResume: (taskId: string, agentId: string) => Promise<void>;
  onDone: (taskId: string) => Promise<void>;
  onSelect: (taskId: string) => void;
  onShowLog: (taskId: string) => void;
  onDelete: (taskId: string) => Promise<void>;
}

const TaskColumn = memo(function TaskColumn({
  label,
  town,
  accentColor,
  tasks,
  assignedAgentById,
  idleAgents,
  roleLabelByAgentId,
  interactivePrompts,
  onRun,
  onStop,
  onResume,
  onDone,
  onSelect,
  onShowLog,
  onDelete,
}: TaskColumnProps) {
  return (
    <div style={{ flex: 1, minWidth: "240px", maxWidth: "340px" }}>
      {/* Column header */}
      <div style={{
        padding: "8px 12px",
        marginBottom: "8px",
        display: "flex",
        alignItems: "center",
        gap: "8px",
      }}>
        <span style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: accentColor,
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "var(--text-primary)",
        }}>{town}</span>
        <span style={{
          fontSize: "12px",
          fontWeight: 500,
          color: "var(--text-tertiary)",
        }}>{tasks.length}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            assignedAgent={task.assigned_agent_id ? assignedAgentById.get(task.assigned_agent_id) : undefined}
            idleAgents={idleAgents}
            roleLabelByAgentId={roleLabelByAgentId}
            hasInteractivePrompt={interactivePrompts.has(task.id)}
            interactivePrompt={interactivePrompts.get(task.id)}
            onRun={onRun}
            onStop={onStop}
            onResume={onResume}
            onDone={onDone}
            onSelect={onSelect}
            onShowLog={onShowLog}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
});

const DETAIL_LAYOUT_STORAGE_KEY = "ao:task-detail-layout-mode";

function loadDetailLayoutMode(): TaskDetailLayoutMode {
  if (typeof window === "undefined") return "modal";
  const stored = window.localStorage.getItem(DETAIL_LAYOUT_STORAGE_KEY);
  if (stored === "pinned-left" || stored === "pinned-right" || stored === "modal") {
    return stored;
  }
  return "modal";
}

export function TaskBoard({ tasks, agents, interactivePrompts, onReload, onSubscribeTask, onWsEvent }: TaskBoardProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [logTaskId, setLogTaskId] = useState<string | null>(null);
  const [detailLayoutMode, setDetailLayoutModeState] = useState<TaskDetailLayoutMode>(loadDetailLayoutMode);

  // Persist the pin state so it survives reloads. Modal is the default and
  // does not need to be written explicitly, but we store it so switching
  // back to modal is also remembered.
  const setDetailLayoutMode = useCallback((mode: TaskDetailLayoutMode) => {
    setDetailLayoutModeState(mode);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DETAIL_LAYOUT_STORAGE_KEY, mode);
    }
  }, []);
  const on = onWsEvent;
  const { play } = useSfx();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const taskParam = searchParams.get("task");
    if (taskParam && tasks.some((t) => t.id === taskParam)) {
      setSelectedTaskId(taskParam);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, tasks, setSearchParams]);

  // Drop the selection when the underlying task disappears
  useEffect(() => {
    if (selectedTaskId && !tasks.some((t) => t.id === selectedTaskId)) {
      setSelectedTaskId(null);
      setDetailTask(null);
    }
  }, [selectedTaskId, tasks]);

  // Fetch full task detail when selection changes
  useEffect(() => {
    if (!selectedTaskId) {
      setDetailTask(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetchTask(selectedTaskId)
      .then((task) => {
        if (!cancelled) setDetailTask(task);
      })
      .catch(() => {
        if (!cancelled) setDetailTask(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedTaskId]);

  // Refresh detail when the summary list updates (e.g. WS status change)
  useEffect(() => {
    if (!selectedTaskId || !detailTask) return;
    const summary = tasks.find((t) => t.id === selectedTaskId);
    if (!summary) return;
    if (summary.updated_at !== detailTask.updated_at) {
      fetchTask(selectedTaskId)
        .then((task) => setDetailTask(task))
        .catch(() => {});
    }
  }, [selectedTaskId, tasks, detailTask]);

  // Listen for sidebar button events
  useEffect(() => {
    const onNewTask = () => { play("select"); setShowCreate(true); };
    const onNewAgent = () => { play("select"); setShowAddAgent(true); };
    window.addEventListener("ao:new-task", onNewTask);
    window.addEventListener("ao:new-agent", onNewAgent);
    return () => {
      window.removeEventListener("ao:new-task", onNewTask);
      window.removeEventListener("ao:new-agent", onNewAgent);
    };
  }, [play]);

  const handleCreate = useCallback(async (data: Parameters<typeof createTask>[0]) => {
    await createTask(data);
    setShowCreate(false);
    play("confirm");
    onReload();
  }, [onReload, play]);

  const handleRun = useCallback(async (taskId: string, agentId: string) => {
    play("confirm");
    await runTask(taskId, agentId);
    onReload();
  }, [onReload, play]);

  const handleStop = useCallback(async (taskId: string) => {
    play("cancel");
    await stopTask(taskId);
    onReload();
  }, [onReload, play]);

  const handleResume = useCallback(async (taskId: string, agentId: string) => {
    play("confirm");
    await resumeTask(taskId, agentId);
    onReload();
  }, [onReload, play]);

  const handleDone = useCallback(async (taskId: string) => {
    play("confirm");
    await updateTask(taskId, { status: "done" });
    onReload();
  }, [onReload, play]);

  const handleDelete = useCallback(async (taskId: string) => {
    if (!window.confirm("Delete this task?")) return;
    play("cancel");
    await deleteTask(taskId);
    onReload();
  }, [onReload, play]);

  const handleAddAgent = useCallback(async (data: AgentFormData) => {
    await createAgent(data as unknown as Partial<Agent>);
    setShowAddAgent(false);
    play("confirm");
    onReload();
  }, [onReload, play]);

  const agentView = useMemo(() => buildAgentViewState(agents), [agents]);
  const columnsRef = useRef<TaskColumns>(createEmptyTaskColumns());
  const tasksByStatus = useMemo(() => {
    const grouped = groupTasksByStatusStable(tasks, columnsRef.current);
    columnsRef.current = grouped;
    return grouped;
  }, [tasks]);

  const handleBoardRender = useCallback((id: string, phase: "mount" | "update" | "nested-update", actualDuration: number) => {
    if (typeof window === "undefined") {
      return;
    }
    if (actualDuration < 8) {
      return;
    }
    console.debug("[perf]", id, phase, `${actualDuration.toFixed(1)}ms`);
  }, []);

  // When a task is pinned open, push the kanban content away from the docked
  // panel so the rightmost / leftmost column does not sit behind it.
  const pinnedPanelVisible = selectedTaskId !== null && detailLayoutMode !== "modal";
  const boardPaddingLeft = pinnedPanelVisible && detailLayoutMode === "pinned-left" ? `${PINNED_PANEL_WIDTH_PX}px` : undefined;
  const boardPaddingRight = pinnedPanelVisible && detailLayoutMode === "pinned-right" ? `${PINNED_PANEL_WIDTH_PX}px` : undefined;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        paddingLeft: boardPaddingLeft,
        paddingRight: boardPaddingRight,
        transition: "padding 150ms ease",
      }}
    >

      {/* Empty state */}
      {agents.length === 0 && tasks.length === 0 && !showAddAgent && (
        <div style={{
          padding: "48px",
          textAlign: "center",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: "8px",
        }}>
          <p style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>No agents yet</p>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px" }}>Create an agent to start running tasks</p>
          <button
            onClick={() => { play("select"); setShowAddAgent(true); }}
            className="eb-btn eb-btn--primary"
          >
            + Create First Agent
          </button>
        </div>
      )}

      {/* Kanban columns */}
      <Profiler id="TaskBoardColumns" onRender={handleBoardRender}>
      <div className="kanban-scroll" style={{ display: "flex", gap: "12px", overflowX: "auto" }}>
        {TASK_BOARD_COLUMNS.map((col) => {
          const colTasks = tasksByStatus[col.key];
          return (
            <TaskColumn
              key={col.key}
              label={col.label}
              town={col.town}
              accentColor={col.accentColor}
              tasks={colTasks}
              assignedAgentById={agentView.agentById}
              idleAgents={agentView.idleAgents}
              roleLabelByAgentId={agentView.roleLabelById}
              interactivePrompts={interactivePrompts}
              onRun={handleRun}
              onStop={handleStop}
              onResume={handleResume}
              onDone={handleDone}
              onSelect={setSelectedTaskId}
              onShowLog={setLogTaskId}
              onDelete={handleDelete}
            />
          );
        })}
      </div>
      </Profiler>

      {/* Modals */}
      {selectedTaskId && (() => {
        if (detailLoading && !detailTask) {
          return (
            <div style={{
              position: "fixed", inset: 0, zIndex: 50,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(0,0,0,0.6)",
            }}>
              <div style={{ color: "var(--text-secondary)", fontSize: "14px" }}>Loading...</div>
            </div>
          );
        }
        if (!detailTask) return null;
        return (
          <TaskDetailModal
            task={detailTask}
            agents={agents}
            interactivePrompt={interactivePrompts.get(detailTask.id)}
            on={on}
            subscribeTask={onSubscribeTask}
            onClose={() => setSelectedTaskId(null)}
            onRun={handleRun}
            onStop={handleStop}
            onResume={handleResume}
            layoutMode={detailLayoutMode}
            onLayoutModeChange={setDetailLayoutMode}
          />
        );
      })()}

      {showAddAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <AgentForm
            onSubmit={handleAddAgent}
            onCancel={() => setShowAddAgent(false)}
          />
        </div>
      )}

      {showCreate && (
        <CreateTaskModal
          agents={agents}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}

      {logTaskId && (() => {
        const logTask = tasks.find((t) => t.id === logTaskId);
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            onClick={() => setLogTaskId(null)}
          >
            <div
              className="w-full max-w-4xl max-h-[85vh] mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <TerminalPanel
                taskId={logTaskId}
                on={on}
                subscribeTask={onSubscribeTask}
                onClose={() => setLogTaskId(null)}
                agents={agents}
                currentStage={logTask?.status ?? null}
                currentAgentId={logTask?.assigned_agent_id ?? null}
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
