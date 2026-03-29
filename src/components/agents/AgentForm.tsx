import { useState } from "react";
import { AGENT_ROLES } from "./roles.js";

export interface AgentFormData {
  name: string;
  cli_provider: string;
  cli_model: string | null;
  avatar_emoji: string;
  role: string | null;
  agent_type: "worker" | "ceo";
  personality: string | null;
}

interface AgentFormProps {
  initial?: {
    name?: string;
    cli_provider?: string;
    cli_model?: string | null;
    avatar_emoji?: string;
    role?: string | null;
    agent_type?: "worker" | "ceo";
    personality?: string | null;
  };
  onSubmit: (data: AgentFormData) => void;
  onCancel: () => void;
  submitLabel?: string;
}

const inputStyle = {
  background: "var(--bg-tertiary)",
  border: "1px solid var(--border-default)",
  borderRadius: "6px",
  padding: "8px 12px",
  fontSize: "13px",
  color: "var(--text-primary)",
  outline: "none",
  width: "100%",
} as const;

const labelStyle = {
  fontSize: "12px",
  fontWeight: 500,
  color: "var(--text-secondary)",
} as const;

export function AgentForm({ initial, onSubmit, onCancel, submitLabel = "Create" }: AgentFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [provider, setProvider] = useState(initial?.cli_provider ?? "claude");
  const [model, setModel] = useState(initial?.cli_model ?? "");
  const [emoji, setEmoji] = useState(initial?.avatar_emoji ?? "\ud83e\udd16");
  const [role, setRole] = useState(initial?.role ?? "");
  const [agentType, setAgentType] = useState<"worker" | "ceo">(initial?.agent_type ?? "worker");
  const [personality, setPersonality] = useState(initial?.personality ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      cli_provider: provider,
      cli_model: model.trim() || null,
      avatar_emoji: emoji,
      role: role || null,
      agent_type: agentType,
      personality: personality.trim() || null,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: "12px",
        padding: "24px",
        maxWidth: "480px",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "12px", alignItems: "center" }}>
        <label style={labelStyle}>Emoji</label>
        <input
          style={{ ...inputStyle, width: "64px", textAlign: "center" }}
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
        />

        <label style={labelStyle}>Name</label>
        <input
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. coder-01"
          autoFocus
        />

        <label style={labelStyle}>Provider</label>
        <select
          style={inputStyle}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex CLI</option>
          <option value="gemini">Gemini CLI</option>
        </select>

        <label style={labelStyle}>Role</label>
        <select
          style={inputStyle}
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="">\u2014 None \u2014</option>
          {AGENT_ROLES.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>

        <label style={labelStyle}>Type</label>
        <select
          style={inputStyle}
          value={agentType}
          onChange={(e) => setAgentType(e.target.value as "worker" | "ceo")}
        >
          <option value="worker">Worker</option>
          <option value="ceo">CEO</option>
        </select>

        <label style={labelStyle}>Model</label>
        <input
          style={inputStyle}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="(default)"
        />

        <label style={labelStyle}>Personality</label>
        <textarea
          style={{ ...inputStyle, height: "64px", resize: "none" }}
          value={personality}
          onChange={(e) => setPersonality(e.target.value)}
          placeholder="Optional system prompt..."
        />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
        <button
          type="button"
          onClick={onCancel}
          className="eb-btn"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="eb-btn eb-btn--primary"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
