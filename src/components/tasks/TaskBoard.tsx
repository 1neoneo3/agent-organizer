import { useState, useEffect } from "react";
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

const COLUMNS = [
  { key: "inbox", label: "INBOX", town: "Onett" },
  { key: "in_progress", label: "IN PROGRESS", town: "Twoson" },
  { key: "self_review", label: "SELF REVIEW", town: "Threed" },
  { key: "pr_review", label: "PR REVIEW", town: "Fourside" },
  { key: "done", label: "DONE", town: "Magicant" },
] as const;

interface TaskBoardProps {
  tasks: Task[];
  agents: Agent[];
  interactivePrompts: Map<string, InteractivePrompt>;
  onReload: () => void;
}

export function TaskBoard({ tasks, agents, interactivePrompts, onReload }: TaskBoardProps) {
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

  const handleCreate = async (data: Parameters<typeof createTask>[0]) => {
    await createTask(data);
    setShowCreate(false);
    play("confirm");
    onReload();
  };

  const handleRun = async (taskId: string, agentId: string) => {
    play("confirm");
    await runTask(taskId, agentId);
    onReload();
  };

  const handleStop = async (taskId: string) => {
    play("cancel");
    await stopTask(taskId);
    onReload();
  };

  const handleDone = async (taskId: string) => {
    play("confirm");
    await updateTask(taskId, { status: "done" });
    onReload();
  };

  const handleDelete = async (taskId: string) => {
    if (!window.confirm("このタスクを削除しますか？")) return;
    play("cancel");
    await deleteTask(taskId);
    onReload();
  };

  const handleAddAgent = async (data: AgentFormData) => {
    await createAgent(data as unknown as Partial<Agent>);
    setShowAddAgent(false);
    play("confirm");
    onReload();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* Header bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h2 className="eb-heading" style={{ fontSize: "12px" }}>TOWN MAP</h2>
          {agents.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {agents.map((a) => {
                const isWorking = a.status === "working";
                return (
                  <span
                    key={a.id}
                    className="eb-window"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "3px 6px",
                      fontSize: "8px",
                      fontFamily: "var(--eb-font-heading)",
                      boxShadow: "2px 2px 0 var(--eb-shadow)",
                    }}
                    title={`${a.name} (${a.status})`}
                  >
                    <span className={isWorking ? "eb-sprite-working" : "eb-sprite-idle"}>
                      <PixelAvatar role={a.role} size={16} className="inline-block align-middle" />
                    </span>
                    <span>{a.name}</span>
                    {getRoleLabel(a.role) && (
                      <span className="eb-label" style={{ fontSize: "7px" }}>[{getRoleLabel(a.role)}]</span>
                    )}
                    {/* Mini HP bar */}
                    <div className="eb-hp-bar" style={{ width: "24px", height: "4px" }}>
                      <div
                        className={`eb-hp-fill ${isWorking ? "" : "eb-hp-fill--warning"}`}
                        style={{ width: isWorking ? "100%" : "40%" }}
                      />
                    </div>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          <button
            onClick={() => { play("select"); setShowAddAgent(true); }}
            className="eb-btn"
          >
            + AGENT
          </button>
          <button
            onClick={() => { play("select"); setShowCreate(true); }}
            className="eb-btn eb-btn--primary"
          >
            + NEW QUEST
          </button>
        </div>
      </div>

      {/* Empty state */}
      {agents.length === 0 && tasks.length === 0 && !showAddAgent && (
        <div className="eb-window" style={{ padding: "32px", textAlign: "center" }}>
          <div className="eb-window-body">
            <p className="eb-heading" style={{ marginBottom: "8px" }}>NO PARTY MEMBERS</p>
            <p className="eb-body" style={{ marginBottom: "16px", color: "var(--eb-text-sub)" }}>Create an agent to start running quests</p>
            <button
              onClick={() => { play("select"); setShowAddAgent(true); }}
              className="eb-btn eb-btn--primary"
            >
              + CREATE FIRST AGENT
            </button>
          </div>
        </div>
      )}

      {/* Kanban columns */}
      <div style={{ display: "flex", gap: "10px", overflowX: "auto" }}>
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.key);
          return (
            <div key={col.key} style={{ flex: 1, minWidth: "220px", maxWidth: "320px" }}>
              {/* Column header */}
              <div className="eb-window" style={{ marginBottom: "8px" }}>
                <div style={{ padding: "6px 10px", textAlign: "center" }}>
                  <div className="eb-heading" style={{ fontSize: "10px", color: "var(--eb-highlight)" }}>{col.town}</div>
                  <div className="eb-label" style={{ fontSize: "7px", marginTop: "2px" }}>{col.label} ({colTasks.length})</div>
                </div>
              </div>
              {/* Cards */}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {colTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    agents={agents}
                    hasInteractivePrompt={interactivePrompts.has(task.id)}
                    onRun={handleRun}
                    onStop={handleStop}
                    onDone={handleDone}
                    onSelect={setSelectedTaskId}
                    onShowLog={setLogTaskId}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

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
              onClose={() => setLogTaskId(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
