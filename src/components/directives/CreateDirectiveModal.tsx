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
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: "12px",
          padding: "24px",
          width: "100%",
          maxWidth: "480px",
        }}
      >
        <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "20px" }}>New Directive</h2>

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
            placeholder="e.g. Implement user authentication"
            autoFocus
          />
        </label>

        <label style={{ display: "block", marginBottom: "16px" }}>
          <span style={{ display: "block", fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "4px" }}>Content</span>
          <textarea
            style={{
              width: "100%",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-default)",
              borderRadius: "6px",
              padding: "8px 12px",
              fontSize: "13px",
              color: "var(--text-primary)",
              height: "128px",
              resize: "none",
              outline: "none",
            }}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Describe what needs to be accomplished..."
          />
        </label>

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

        <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "20px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={autoDecompose}
            onChange={(e) => setAutoDecompose(e.target.checked)}
            style={{ width: "16px", height: "16px", accentColor: "var(--accent-primary)" }}
          />
          <span style={{ fontSize: "13px", color: "var(--text-primary)" }}>Auto-decompose into tasks</span>
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
            Create Directive
          </button>
        </div>
      </form>
    </div>
  );
}
