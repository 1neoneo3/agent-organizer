import type { DatabaseSync } from "node:sqlite";

/**
 * Per-task settings override support.
 *
 * Resolution precedence (first match wins):
 *   1. tasks.settings_overrides JSON (per-task)
 *   2. settings table (global)
 *   3. undefined (caller's default)
 *
 * Callers that do not have a task context should pass `undefined` for
 * `taskId` — in that case the helper only consults the global table and
 * the behavior matches the pre-override `getSetting` helpers that were
 * previously duplicated across modules.
 */
export function getTaskSetting(
  db: DatabaseSync,
  key: string,
  taskId?: string | null,
): string | undefined {
  if (taskId) {
    const override = readTaskOverride(db, key, taskId);
    if (override !== undefined) return override;
  }
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Read a single override value from `tasks.settings_overrides` JSON, or
 * return `undefined` when no override exists for this key. Never
 * throws on malformed JSON (treated as "no override").
 */
function readTaskOverride(
  db: DatabaseSync,
  key: string,
  taskId: string,
): string | undefined {
  const row = db
    .prepare("SELECT settings_overrides FROM tasks WHERE id = ?")
    .get(taskId) as { settings_overrides: string | null } | undefined;
  const raw = row?.settings_overrides;
  if (!raw) return undefined;
  const parsed = safeParseOverrides(raw);
  if (!parsed) return undefined;
  const value = parsed[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Parse the JSON blob in `tasks.settings_overrides` into a flat
 * string→string record. Returns null if the payload is malformed or
 * not an object — callers then fall back to the global setting.
 */
export function safeParseOverrides(
  raw: string | null | undefined,
): Record<string, string> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Merge a partial patch into `tasks.settings_overrides` JSON. Keys
 * mapped to `null` are removed. Returns the resulting record (or null
 * when the final object is empty, so the column is cleared).
 */
export function mergeOverrides(
  existing: string | null | undefined,
  patch: Record<string, string | null>,
): Record<string, string> | null {
  const current = safeParseOverrides(existing) ?? {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete current[k];
    } else {
      current[k] = v;
    }
  }
  return Object.keys(current).length === 0 ? null : current;
}

/**
 * Allow-list of setting keys that can be overridden per task. Kept in
 * sync with the global `SETTINGS_DEFAULTS` plus the extra keys that the
 * settings route already allows for PUT /settings. Anything outside
 * this list is rejected at the API boundary so a typo cannot silently
 * create dead config.
 */
export const TASK_OVERRIDABLE_KEYS: readonly string[] = [
  "review_mode",
  "review_count",
  "qa_mode",
  "qa_count",
  "self_review_threshold",
  "auto_review",
  "auto_qa",
  "auto_checks_enabled",
  "default_enable_test_generation",
  "default_enable_refinement",
  "refinement_auto_approve",
  "refinement_as_pr",
  "default_enable_ci_check",
  "default_enable_human_review",
  "explore_phase",
  "check_types_cmd",
  "check_lint_cmd",
  "check_tests_cmd",
  "check_e2e_cmd",
  "output_language",
] as const;

const TASK_OVERRIDABLE_SET = new Set(TASK_OVERRIDABLE_KEYS);

export function isTaskOverridableKey(key: string): boolean {
  return TASK_OVERRIDABLE_SET.has(key);
}
