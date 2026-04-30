import { useState, useEffect } from "react";
import { fetchAgents, updateSettings } from "../../api/endpoints.js";
import { getAllCliModelOptions } from "../../cliModels.js";
import type { Agent, Settings } from "../../types/index.js";
import { AGENT_ROLES, getRoleLabel } from "../agents/roles.js";

interface SettingsPanelProps {
  settings: Settings;
  onReload: () => void;
}

interface StageAgentOption {
  roleKey: string;
  modelKey: string;
  label: string;
  description: string;
}

const STAGE_AGENT_OPTIONS: StageAgentOption[] = [
  {
    roleKey: "refinement_agent_role",
    modelKey: "refinement_agent_model",
    label: "Plan Stage",
    description: "Filter plan-stage workers by role and/or model. A random idle match is selected before falling back to the normal resolver.",
  },
  {
    roleKey: "review_agent_role",
    modelKey: "review_agent_model",
    label: "PR Review Stage",
    description: "Filter the primary PR reviewer by role and/or model. The security_reviewer secondary slot still applies.",
  },
  {
    roleKey: "qa_agent_role",
    modelKey: "qa_agent_model",
    label: "QA Testing Stage",
    description: "Filter QA workers by role and/or model. A random idle match is selected before falling back to the default tester selection.",
  },
  {
    roleKey: "test_generation_agent_role",
    modelKey: "test_generation_agent_model",
    label: "Test Generation Stage",
    description: "Filter test-generation workers by role and/or model. A random idle match is selected before falling back to the default tester selection.",
  },
];

const inputStyle = {
  width: "100%",
  background: "var(--bg-tertiary)",
  border: "1px solid var(--border-default)",
  borderRadius: "6px",
  padding: "8px 12px",
  fontSize: "13px",
  color: "var(--text-primary)",
  outline: "none",
  marginTop: "4px",
} as const;

const textareaStyle = {
  ...inputStyle,
  minHeight: "88px",
  resize: "vertical",
} as const;

export function SettingsPanel({ settings, onReload }: SettingsPanelProps) {
  const [local, setLocal] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    setLocal(settings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    fetchAgents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const workerAgents = agents.filter((a) => a.agent_type === "worker");
  const modelOptions = [
    ...new Set([
      ...getAllCliModelOptions(),
      ...workerAgents
        .map((agent) => agent.cli_model?.trim() ?? "")
        .filter((model) => model.length > 0),
    ]),
  ].sort((left, right) => left.localeCompare(right));

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings(local);
      onReload();
    } finally {
      setSaving(false);
    }
  };

  const update = (key: string, value: string) => {
    setLocal((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div>
      <h2 style={{ fontSize: "18px", fontWeight: 600, color: "var(--text-primary)", margin: "0 0 24px 0" }}>Settings</h2>

      <div style={{ maxWidth: "480px", display: "flex", flexDirection: "column", gap: "28px" }}>
        <section>
          <h3 style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-tertiary)", marginBottom: "16px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Language</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Output Language</span>
              <select
                style={inputStyle}
                value={local.output_language ?? "ja"}
                onChange={(e) => update("output_language", e.target.value)}
              >
                <option value="ja">日本語 (Japanese)</option>
                <option value="en">English</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Language used for agent-generated artifacts: task titles, task descriptions, implementation plans, review/QA narrative text, and PR titles/bodies. Control tokens (SPRINT CONTRACT markers, review verdicts, REFINEMENT fences) stay fixed so downstream parsers keep working.
              </p>
            </label>
          </div>
        </section>

        <section>
          <h3 style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-tertiary)", marginBottom: "16px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Workspace</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Default Workspace Mode</span>
              <select
                style={inputStyle}
                value={local.default_workspace_mode ?? "git-worktree"}
                onChange={(e) => update("default_workspace_mode", e.target.value)}
              >
                <option value="git-worktree">Git worktree (isolated per task)</option>
                <option value="shared">Shared (main checkout)</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Applied when a project's WORKFLOW.md does not explicitly set <code>workspace_mode</code>. <strong>Git worktree</strong> isolates each in_progress task in <code>.ao-worktrees/&lt;taskId&gt;</code> on its own branch so concurrent tasks on the same repo don't clobber each other's working tree. <strong>Shared</strong> runs every task directly in the main checkout (legacy behavior).
              </p>
            </label>
          </div>
        </section>

        <section>
          <h3 style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-tertiary)", marginBottom: "16px", textTransform: "uppercase", letterSpacing: "0.05em" }}>GitHub Write</h3>
          <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginBottom: "12px", lineHeight: 1.5 }}>
            Enable this only for repos that should allow agent-side <code>git push</code> and <code>gh pr create</code>. When enabled, Codex runs with a more permissive sandbox for the active task, and optional shell environment passthrough can expose GitHub credentials to the sandbox.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>GitHub Write Mode</span>
              <select
                style={inputStyle}
                value={local.github_write_mode ?? "disabled"}
                onChange={(e) => update("github_write_mode", e.target.value)}
              >
                <option value="disabled">Disabled</option>
                <option value="enabled">Enabled</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Disabled means the host will promote the review artifact after the run. Enabled lets the agent push and open PRs directly when the repo is allowed.
              </p>
            </label>

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Allowed Repos</span>
              <textarea
                style={textareaStyle}
                value={local.github_write_allowed_repos ?? ""}
                onChange={(e) => update("github_write_allowed_repos", e.target.value)}
                placeholder="owner/repo or https://github.com/owner/repo, one per line or comma-separated"
              />
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Leave blank to allow any detected GitHub repository for this installation. Use one repo per line for stricter control.
              </p>
            </label>

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Token Passthrough</span>
              <select
                style={inputStyle}
                value={local.github_write_token_passthrough ?? "false"}
                onChange={(e) => update("github_write_token_passthrough", e.target.value)}
              >
                <option value="false">Disabled</option>
                <option value="true">Enabled</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                When enabled, Codex inherits the shell environment so existing GitHub auth variables can reach the sandbox.
              </p>
            </label>
          </div>
        </section>

        <section>
          <h3 style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-tertiary)", marginBottom: "16px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Review Settings</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Review Mode</span>
              <select
                style={inputStyle}
                value={local.review_mode ?? "pr_only"}
                onChange={(e) => update("review_mode", e.target.value)}
              >
                <option value="none">None (auto-approve all)</option>
                <option value="pr_only">PR Review only</option>
                <option value="meeting">Meeting review</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                "None" skips all PR reviews. "PR only" routes completed work through PR review before human approval or done.
              </p>
            </label>

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Review Count</span>
              <input
                type="number"
                style={inputStyle}
                value={local.review_count ?? "1"}
                onChange={(e) => update("review_count", e.target.value)}
                min={0}
                max={5}
              />
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Number of review rounds required before approval.
              </p>
            </label>

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Auto Review</span>
              <select
                style={inputStyle}
                value={local.auto_review ?? "true"}
                onChange={(e) => update("auto_review", e.target.value)}
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Automatically trigger a review agent when a task enters "PR Review" status.
              </p>
            </label>

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>QA Mode</span>
              <select
                style={inputStyle}
                value={local.qa_mode ?? "disabled"}
                onChange={(e) => update("qa_mode", e.target.value)}
              >
                <option value="disabled">Disabled</option>
                <option value="enabled">Enabled</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Route completed tasks through QA testing before PR review.
              </p>
            </label>

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Auto QA</span>
              <select
                style={inputStyle}
                value={local.auto_qa ?? "true"}
                onChange={(e) => update("auto_qa", e.target.value)}
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Automatically trigger a QA agent when a task enters "QA Testing" status.
              </p>
            </label>

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>QA Count</span>
              <input
                type="number"
                style={inputStyle}
                value={local.qa_count ?? "2"}
                onChange={(e) => update("qa_count", e.target.value)}
                min={1}
                max={5}
              />
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Maximum QA iterations before returning to inbox.
              </p>
            </label>

          </div>
        </section>

        <section>
          <h3 style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-tertiary)", marginBottom: "16px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Workflow Stage Defaults</h3>
          <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginBottom: "12px", lineHeight: 1.5 }}>
            Global defaults for optional pipeline stages. A project's <code>WORKFLOW.md</code> can still override each stage individually; these settings only apply when the file is missing or the flag is not specified.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Plan Stage</span>
              <select
                style={inputStyle}
                value={local.default_enable_refinement ?? "false"}
                onChange={(e) => update("default_enable_refinement", e.target.value)}
              >
                <option value="false">Disabled</option>
                <option value="true">Enabled</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Run a planning agent before implementation to produce requirements, acceptance criteria, and expected outcomes.
              </p>
            </label>

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Plan Auto-Approve</span>
              <select
                style={inputStyle}
                value={local.refinement_auto_approve ?? "false"}
                onChange={(e) => update("refinement_auto_approve", e.target.value)}
              >
                <option value="false">Require human approval</option>
                <option value="true">Auto-approve (skip human gate)</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                When enabled, the implementation plan auto-advances without waiting for human review.
              </p>
            </label>

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Test Generation Stage</span>
              <select
                style={inputStyle}
                value={local.default_enable_test_generation ?? "false"}
                onChange={(e) => update("default_enable_test_generation", e.target.value)}
              >
                <option value="false">Disabled</option>
                <option value="true">Enabled</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Run a dedicated tester agent before QA for medium/large tasks. Small tasks always skip this stage.
              </p>
            </label>

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Human Review Stage</span>
              <select
                style={inputStyle}
                value={local.default_enable_human_review ?? "false"}
                onChange={(e) => update("default_enable_human_review", e.target.value)}
              >
                <option value="false">Disabled</option>
                <option value="true">Enabled</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Require explicit human approval after PR review before moving to deploy / done.
              </p>
            </label>

          </div>
        </section>

        <section>
          <h3 style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-tertiary)", marginBottom: "16px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Auto Dispatch</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Auto Dispatch Mode</span>
              <select
                style={inputStyle}
                value={local.auto_dispatch_mode ?? "github_only"}
                onChange={(e) => update("auto_dispatch_mode", e.target.value)}
              >
                <option value="disabled">Disabled</option>
                <option value="github_only">GitHub-synced inbox tasks only</option>
                <option value="all_inbox">All inbox tasks</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Automatically assigns an idle worker agent and starts matching inbox tasks in the background.
              </p>
            </label>
          </div>
        </section>

        <section>
          <h3 style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-tertiary)", marginBottom: "16px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Stage-Specific Agent Assignments</h3>
          <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginBottom: "12px", lineHeight: 1.5 }}>
            Override the default role-based agent selection for each workflow stage. When a stage has a role and/or model filter, the system chooses a random idle worker that matches the configured combination. If no worker matches at dispatch time, it falls back to the normal role-based resolver. The per-task implementer (in_progress) continues to be chosen automatically.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {STAGE_AGENT_OPTIONS.map((option) => (
              <label key={option.roleKey} style={{ display: "block" }}>
                <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>{option.label}</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "4px" }}>
                  <select
                    style={{ ...inputStyle, marginTop: 0 }}
                    value={local[option.roleKey] ?? ""}
                    onChange={(e) => update(option.roleKey, e.target.value)}
                  >
                    <option value="">Any role (use default resolver)</option>
                    {AGENT_ROLES.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                  <select
                    style={{ ...inputStyle, marginTop: 0 }}
                    value={local[option.modelKey] ?? ""}
                    onChange={(e) => update(option.modelKey, e.target.value)}
                  >
                    <option value="">Any model</option>
                    {modelOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </div>
                <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                  Current selection: {(local[option.roleKey] ? getRoleLabel(local[option.roleKey]) ?? local[option.roleKey] : "any role")} × {(local[option.modelKey] || "any model")}
                </p>
                <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>{option.description}</p>
              </label>
            ))}
          </div>
        </section>

        <button
          onClick={handleSave}
          disabled={saving}
          className="eb-btn eb-btn--primary"
          style={{ alignSelf: "flex-start", opacity: saving ? 0.5 : 1 }}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
