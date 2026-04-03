import { memo, Profiler, useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { TaskCard } from "./TaskCard.js";
import { CreateTaskModal } from "./CreateTaskModal.js";
import { TaskDetailModal } from "./TaskDetailModal.js";
import { TerminalPanel } from "../terminal/TerminalPanel.js";
import { createTask, runTask, stopTask, updateTask, deleteTask, createAgent } from "../../api/endpoints.js";
import { AgentForm, type AgentFormData } from "../agents/AgentForm.js";
import { getRoleLabel } from "../agents/roles.js";
import { PixelAvatar } from "../agents/PixelAvatar.js";
import { useSfx } from "../../hooks/useSfx.js";
import type { Task, Agent, InteractivePrompt } from "../../types/index.js";
import { useWebSocket } from "../../hooks/useWebSocket.js";
import { buildAgentViewState } from "./agent-view.js";
import { TASK_BOARD_COLUMNS, createEmptyTaskColumns, groupTasksByStatusStable, type TaskColumns } from "./task-columns.js";

interface TaskBoardProps {
  tasks: Task[];
  agents: Agent[];
  interactivePrompts: Map<string, InteractivePrompt>;
  onReload: () => void;
  onSubscribeTask?: (taskId: string) => () => void;
}

interface TaskColumnProps {
  label: string;
  town: string;
  accentColor: string;
  tasks: Task[];
  assignedAgentById: Map<string, Agent>;
  idleAgents: Agent[];
  roleLabelByAgentId: Map<string, string>;
  interactivePrompts: Map<string, InteractivePrompt>;
  onRun: (taskId: string, agentId: string) => Promise<void>;
  onStop: (taskId: string) => Promise<void>;
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
  onDone,
  onSelect,
  onShowLog,
  onDelete,
}: TaskColumnProps) {
  return (
    <div style={{ flex: 1, minWidth: "240px", maxWidth: "340px" }}>
      {/* Column header */}
      <div className="column-header-pill" style={{
        marginBottom: "12px",
        display: "flex",
        alignItems: "center",
        gap: "10px",
      }}>
        <span style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: accentColor,
          flexShrink: 0,
          boxShadow: `0 0 12px ${accentColor}60, 0 0 4px ${accentColor}40`,
        }} />
        <span style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "var(--text-primary)",
          letterSpacing: "-0.01em",
        }}>{town}</span>
        <span style={{
          fontSize: "11px",
          fontWeight: 700,
          color: accentColor,
          background: `${accentColor}12`,
          padding: "2px 10px",
          borderRadius: "999px",
          border: `1px solid ${accentColor}18`,
        }}>{tasks.length}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
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

export function TaskBoard({ tasks, agents, interactivePrompts, onReload, onSubscribeTask }: TaskBoardProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [logTaskId, setLogTaskId] = useState<string | null>(null);
  const { on } = useWebSocket();
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Header bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <h2 className="page-title-gradient" style={{ fontSize: "22px", fontWeight: 700, margin: 0, letterSpacing: "-0.03em" }}>Tasks</h2>
          {agents.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {agents.map((a) => {
                const isWorking = a.status === "working";
                return (
                  <span
                    key={a.id}
                    className={`glass-card-static ${isWorking ? "agent-card-working" : ""}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "5px 12px",
                      fontSize: "12px",
                      fontWeight: 500,
                      color: "var(--text-secondary)",
                    }}
                    title={`${a.name} (${a.status})`}
                  >
                    <PixelAvatar role={a.role} size={16} className="inline-block align-middle" />
                    <span>{a.name}</span>
                    {agentView.roleLabelById.get(a.id) && (
                      <span style={{ fontSize: "10px", color: "var(--text-tertiary)" }}>{agentView.roleLabelById.get(a.id)}</span>
                    )}
                    <span
                      className={isWorking ? "status-dot-pulse" : ""}
                      style={{
                        width: "6px",
                        height: "6px",
                        borderRadius: "50%",
                        background: isWorking ? "#22c55e" : "#a0a0a0",
                        flexShrink: 0,
                      }}
                    />
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => { play("select"); setShowAddAgent(true); }}
            className="eb-btn"
          >
            + Agent
          </button>
          <button
            onClick={() => { play("select"); setShowCreate(true); }}
            className="eb-btn eb-btn--primary"
          >
            + New Task
          </button>
        </div>
      </div>

      {/* Empty state */}
      {agents.length === 0 && tasks.length === 0 && !showAddAgent && (
        <div className="glass-card empty-state-shimmer" style={{
          padding: "48px",
          textAlign: "center",
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
      <div style={{ display: "flex", gap: "12px", overflowX: "auto" }}>
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
        const selectedTask = tasks.find((t) => t.id === selectedTaskId);
        if (!selectedTask) return null;
        return (
          <TaskDetailModal
            task={selectedTask}
            agents={agents}
            interactivePrompt={interactivePrompts.get(selectedTask.id)}
            on={on}
            subscribeTask={onSubscribeTask}
            onClose={() => setSelectedTaskId(null)}
            onRun={handleRun}
            onStop={handleStop}
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

      {logTaskId && (
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
            />
          </div>
        </div>
      )}
    </div>
  );
}
