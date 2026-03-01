import { useState } from "react";

interface CreateDirectiveModalProps {
  onClose: () => void;
  onCreate: (data: {
    title: string;
    content: string;
    project_path?: string;
    auto_decompose: boolean;
  }) => void;
}

export function CreateDirectiveModal({ onClose, onCreate }: CreateDirectiveModalProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [projectPath, setProjectPath] = useState("/home/mk/workspace");
  const [autoDecompose, setAutoDecompose] = useState(true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    onCreate({
      title: title.trim(),
      content: content.trim(),
      project_path: projectPath.trim() || undefined,
      auto_decompose: autoDecompose,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-lg border border-gray-200 dark:border-gray-700"
      >
        <h2 className="text-lg font-bold mb-4">New Directive</h2>

        <label className="block mb-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">Title</span>
          <input
            className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Implement user authentication"
            autoFocus
          />
        </label>

        <label className="block mb-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">Content</span>
          <textarea
            className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm h-32 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Describe what needs to be accomplished..."
          />
        </label>

        <label className="block mb-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">Project Path</span>
          <input
            className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
          />
        </label>

        <label className="flex items-center gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={autoDecompose}
            onChange={(e) => setAutoDecompose(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">Auto-decompose into tasks</span>
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
            Create Directive
          </button>
        </div>
      </form>
    </div>
  );
}
