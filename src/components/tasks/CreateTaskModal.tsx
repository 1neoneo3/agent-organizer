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
  }) => void;
}

export function CreateTaskModal({ agents, onClose, onCreate }: CreateTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState("");
  const [projectPath, setProjectPath] = useState("/home/mk/workspace");
  const [taskSize, setTaskSize] = useState<"small" | "medium" | "large">("small");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      description: description.trim(),
      assigned_agent_id: agentId || null,
      project_path: projectPath.trim(),
      task_size: taskSize,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={handleSubmit}
        className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-lg border border-gray-200 dark:border-gray-700"
      >
        <h2 className="text-lg font-bold mb-4">New Task</h2>

        <label className="block mb-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">Title</span>
          <input
            className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be done?"
            autoFocus
          />
        </label>

        <label className="block mb-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">Description</span>
          <textarea
            className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm h-24 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Detailed instructions..."
          />
        </label>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="block">
            <span className="text-sm text-gray-500 dark:text-gray-400">Agent</span>
            <select
              className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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

          <label className="block">
            <span className="text-sm text-gray-500 dark:text-gray-400">Size</span>
            <select
              className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={taskSize}
              onChange={(e) => setTaskSize(e.target.value as "small" | "medium" | "large")}
            >
              <option value="small">Small (self-review)</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
        </div>

        <label className="block mb-4">
          <span className="text-sm text-gray-500 dark:text-gray-400">Project Path</span>
          <input
            className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
          />
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
          >
            Create Task
          </button>
        </div>
      </form>
    </div>
  );
}
