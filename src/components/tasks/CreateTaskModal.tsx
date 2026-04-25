import { useState } from "react";
import type { Agent } from "../../types/index.js";

interface CreateTaskModalProps {
  agents: Agent[];
  onClose: () => void;
  onCreate: (data: {
    title: string;
    description: string;
    assigned_agent_id: string | null;
    project_path: string;
    task_size: "small" | "medium" | "large";
    repository_url: string | null;
  }) => void;
}

export function CreateTaskModal({ agents, onClose, onCreate }: CreateTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState("");
  const [projectPath, setProjectPath] = useState("/home/mk/workspace");
  const [taskSize, setTaskSize] = useState<"small" | "medium" | "large">("small");
  const [repositoryUrl, setRepositoryUrl] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      description: description.trim(),
      assigned_agent_id: agentId || null,
      project_path: projectPath.trim(),
      task_size: taskSize,
      repository_url: repositoryUrl.trim() || null,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={handleSubmit}
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: "12px",
          padding: "24px",
          width: "100%",
          maxWidth: "480px",
        }}
      >
        <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "20px" }}>New Task</h2>

        <label style={{ display: "block", marginBottom: "16px" }}>
          <span style={{ display: "block", fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "4px" }}>Title</span>
          <input
            style={{
              width: "100%",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-default)",
              borderRadius: "6px",
              padding: "8px 12px",
              fontSize: "13px",
              color: "var(--text-primary)",
              outline: "none",
            }}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be done?"
            autoFocus
          />
        </label>

        <label style={{ display: "block", marginBottom: "16px" }}>
          <span style={{ display: "block", fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "4px" }}>Description</span>
          <textarea
            style={{
              width: "100%",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-default)",
              borderRadius: "6px",
              padding: "8px 12px",
              fontSize: "13px",
              color: "var(--text-primary)",
              height: "96px",
              resize: "none",
              outline: "none",
            }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What and why in 2-3 sentences. Implementation details go in the plan."
          />
          <span style={{ display: "block", fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
            Brief overview only. Technical details belong in the Implementation Plan.
          </span>
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
          <label style={{ display: "block" }}>
            <span style={{ display: "block", fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "4px" }}>Agent</span>
            <select
              style={{
                width: "100%",
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-default)",
                borderRadius: "6px",
                padding: "8px 12px",
                fontSize: "13px",
                color: "var(--text-primary)",
                outline: "none",
              }}
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="">Auto-assign</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji} {a.name}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "block" }}>
            <span style={{ display: "block", fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "4px" }}>Size</span>
            <select
              style={{
                width: "100%",
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-default)",
                borderRadius: "6px",
                padding: "8px 12px",
                fontSize: "13px",
                color: "var(--text-primary)",
                outline: "none",
              }}
              value={taskSize}
              onChange={(e) => setTaskSize(e.target.value as "small" | "medium" | "large")}
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
        </div>

        <label style={{ display: "block", marginBottom: "16px" }}>
          <span style={{ display: "block", fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "4px" }}>Project Path</span>
          <input
            style={{
              width: "100%",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-default)",
              borderRadius: "6px",
              padding: "8px 12px",
              fontSize: "13px",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              outline: "none",
            }}
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
          />
        </label>

        <label style={{ display: "block", marginBottom: "20px" }}>
          <span style={{ display: "block", fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "4px" }}>Repository URL <span style={{ color: "var(--text-tertiary)", fontWeight: 400 }}>(auto-detected from project path if blank)</span></span>
          <input
            type="url"
            style={{
              width: "100%",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-default)",
              borderRadius: "6px",
              padding: "8px 12px",
              fontSize: "13px",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              outline: "none",
            }}
            value={repositoryUrl}
            onChange={(e) => setRepositoryUrl(e.target.value)}
            placeholder="https://github.com/user/repo"
          />
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button
            type="button"
            onClick={onClose}
            className="eb-btn"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="eb-btn eb-btn--primary"
          >
            Create Task
          </button>
        </div>
      </form>
    </div>
  );
}
