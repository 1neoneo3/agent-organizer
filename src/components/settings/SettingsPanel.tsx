import { useState, useEffect } from "react";
import { updateSettings } from "../../api/endpoints.js";
import type { Settings } from "../../types/index.js";

interface SettingsPanelProps {
  settings: Settings;
  onReload: () => void;
}

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
      <h2 className="text-xl font-bold mb-6">Settings</h2>

      <div className="max-w-lg space-y-6">
        <section>
          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-3 uppercase tracking-wide">Review Settings</h3>
          <div className="space-y-3">
            <label className="block">
              <span className="text-sm text-gray-500 dark:text-gray-400">Review Mode</span>
              <select
                className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={local.review_mode ?? "pr_only"}
                onChange={(e) => update("review_mode", e.target.value)}
              >
                <option value="none">None (auto-approve all)</option>
                <option value="pr_only">PR Review only</option>
                <option value="meeting">Meeting review</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                "None" skips all reviews. "PR only" requires PR review for non-self-reviewed tasks.
              </p>
            </label>

            <label className="block">
              <span className="text-sm text-gray-500 dark:text-gray-400">Review Count</span>
              <input
                type="number"
                className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={local.review_count ?? "1"}
                onChange={(e) => update("review_count", e.target.value)}
                min={0}
                max={5}
              />
              <p className="text-xs text-gray-500 mt-1">
                Number of review rounds required before approval.
              </p>
            </label>

            <label className="block">
              <span className="text-sm text-gray-500 dark:text-gray-400">Auto Review</span>
              <select
                className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={local.auto_review ?? "true"}
                onChange={(e) => update("auto_review", e.target.value)}
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Automatically trigger a review agent when a task enters "PR Review" status.
              </p>
            </label>

            <label className="block">
              <span className="text-sm text-gray-500 dark:text-gray-400">Self-Review Threshold</span>
              <select
                className="mt-1 w-full bg-gray-100 dark:bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={local.self_review_threshold ?? "small"}
                onChange={(e) => update("self_review_threshold", e.target.value)}
              >
                <option value="none">Disabled</option>
                <option value="small">Small tasks only</option>
                <option value="medium">Small + Medium tasks</option>
                <option value="all">All tasks</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Tasks at or below this size will have the agent self-review and auto-approve.
              </p>
            </label>
          </div>
        </section>

        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 rounded transition-colors font-medium"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
