import type { DatabaseSync } from "node:sqlite";

const TASK_OVERRIDABLE_SETTINGS = [
  "review_mode",
  "review_count",
  "qa_mode",
  "qa_count",
  "self_review_threshold",
  "auto_review",
  "auto_qa",
  "auto_checks_enabled",
  "default_enable_refinement",
  "refinement_auto_approve",
  "refinement_as_pr",
  "default_enable_test_generation",
  "default_enable_ci_check",
  "default_enable_human_review",
  "explore_phase",
  "check_types_cmd",
  "check_lint_cmd",
  "check_tests_cmd",
  "check_e2e_cmd",
  "output_language",
] as const;

export const TASK_OVERRIDABLE_KEYS = [...TASK_OVERRIDABLE_SETTINGS];

type TaskOverrides = Partial<Record<(typeof TASK_OVERRIDABLE_SETTINGS)[number], string>>;

export function isTaskOverridableKey(key: string): key is (typeof TASK_OVERRIDABLE_SETTINGS)[number] {
  return TASK_OVERRIDABLE_KEYS.includes(key as (typeof TASK_OVERRIDABLE_SETTINGS)[number]);
}

export function safeParseOverrides(raw: string | null | undefined): TaskOverrides | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const filtered: TaskOverrides = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isTaskOverridableKey(key) && typeof value === "string") {
        filtered[key] = value;
      }
    }
    return Object.keys(filtered).length > 0 ? filtered : {};
  } catch {
    return null;
  }
}

export function mergeOverrides(
  rawExisting: string | null | undefined,
  patch: Record<string, string | null>,
): TaskOverrides | null {
  const base = safeParseOverrides(rawExisting) ?? {};
  const next: Record<string, string> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (!isTaskOverridableKey(key)) continue;
    if (value === null || value === "") {
      delete next[key];
      continue;
    }
    next[key] = value;
  }

  return Object.keys(next).length > 0 ? next as TaskOverrides : null;
}

export function getTaskSetting(
  db: DatabaseSync,
  key: string,
  taskId?: string,
): string | undefined {
  if (taskId) {
    const taskRow = db
      .prepare("SELECT settings_overrides FROM tasks WHERE id = ?")
      .get(taskId) as { settings_overrides: string | null } | undefined;
    const overrides = safeParseOverrides(taskRow?.settings_overrides);
    const overrideValue = overrides?.[key as keyof TaskOverrides];
    if (typeof overrideValue === "string") {
      return overrideValue;
    }
  }

  const globalRow = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return globalRow?.value;
}
