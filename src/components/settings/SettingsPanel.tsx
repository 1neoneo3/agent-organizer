import { useState, useEffect } from "react";
import { updateSettings } from "../../api/endpoints.js";
import type { Settings } from "../../types/index.js";

interface SettingsPanelProps {
  settings: Settings;
  onReload: () => void;
}

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

export function SettingsPanel({ settings, onReload }: SettingsPanelProps) {
  const [local, setLocal] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLocal(settings);
  }, [settings]);

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
                "None" skips all reviews. "PR only" requires PR review for non-self-reviewed tasks.
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

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Self-Review Threshold</span>
              <select
                style={inputStyle}
                value={local.self_review_threshold ?? "small"}
                onChange={(e) => update("self_review_threshold", e.target.value)}
              >
                <option value="none">Disabled</option>
                <option value="small">Small tasks only</option>
                <option value="medium">Small + Medium tasks</option>
                <option value="all">All tasks</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Tasks at or below this size will have the agent self-review and auto-approve.
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
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Refinement Stage</span>
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
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>Refinement Auto-Approve</span>
              <select
                style={inputStyle}
                value={local.refinement_auto_approve ?? "false"}
                onChange={(e) => update("refinement_auto_approve", e.target.value)}
              >
                <option value="false">Require human approval</option>
                <option value="true">Auto-approve (skip human gate)</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                When enabled, the refinement plan auto-advances to implementation without waiting for human review.
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

            <label style={{ display: "block" }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)" }}>CI Check Stage</span>
              <select
                style={inputStyle}
                value={local.default_enable_ci_check ?? "false"}
                onChange={(e) => update("default_enable_ci_check", e.target.value)}
              >
                <option value="false">Disabled</option>
                <option value="true">Enabled</option>
              </select>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Verify CI/CD infrastructure (workflows, scripts, passing runs) after implementation, before QA.
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
