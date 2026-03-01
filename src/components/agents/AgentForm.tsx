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

export function AgentForm({ initial, onSubmit, onCancel, submitLabel = "Create" }: AgentFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [provider, setProvider] = useState(initial?.cli_provider ?? "claude");
  const [model, setModel] = useState(initial?.cli_model ?? "");
  const [emoji, setEmoji] = useState(initial?.avatar_emoji ?? "🤖");
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
    <form onSubmit={handleSubmit} className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700 max-w-lg">
      <div className="grid grid-cols-[auto_1fr] gap-3 items-center">
        <label className="text-sm text-gray-500 dark:text-gray-400">Emoji</label>
        <input
          className="bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm w-16 text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
        />

        <label className="text-sm text-gray-500 dark:text-gray-400">Name</label>
        <input
          className="bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. coder-01"
          autoFocus
        />

        <label className="text-sm text-gray-500 dark:text-gray-400">Provider</label>
        <select
          className="bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex CLI</option>
          <option value="gemini">Gemini CLI</option>
        </select>

        <label className="text-sm text-gray-500 dark:text-gray-400">Role</label>
        <select
          className="bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="">— None —</option>
          {AGENT_ROLES.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>

        <label className="text-sm text-gray-500 dark:text-gray-400">Type</label>
        <select
          className="bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={agentType}
          onChange={(e) => setAgentType(e.target.value as "worker" | "ceo")}
        >
          <option value="worker">Worker</option>
          <option value="ceo">CEO</option>
        </select>

        <label className="text-sm text-gray-500 dark:text-gray-400">Model</label>
        <input
          className="bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="(default)"
        />

        <label className="text-sm text-gray-500 dark:text-gray-400">Personality</label>
        <textarea
          className="bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm h-16 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={personality}
          onChange={(e) => setPersonality(e.target.value)}
          placeholder="Optional system prompt..."
        />
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
