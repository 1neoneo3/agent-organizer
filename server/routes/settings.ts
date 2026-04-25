import { Router } from "express";
import { z } from "zod";
import type { RuntimeContext } from "../types/runtime.js";
import {
  SETTINGS_DEFAULTS,
  VALID_OUTPUT_LANGUAGES,
  VALID_WORKSPACE_MODES,
} from "../config/runtime.js";

const VALID_SETTINGS_KEYS = new Set([
  ...Object.keys(SETTINGS_DEFAULTS),
  // Additional keys that have no seeded default but are still accepted
  // by the settings API (read via getTaskSetting which returns undefined
  // when the row is absent).
  "explore_phase",
  "github_write_mode",
  "github_write_allowed_repos",
  "github_write_token_passthrough",
  "auto_done",
]);

// Per-key enum validation runs after the generic record<string,string> parse.
// When a key is listed here, only the given values are accepted; unknown
// values yield a 400 before they can be persisted. Keep this list in sync
// with the corresponding UI select options in SettingsPanel.tsx.
const SETTINGS_ENUM_VALUES: Record<string, readonly string[]> = {
  output_language: VALID_OUTPUT_LANGUAGES,
  default_workspace_mode: VALID_WORKSPACE_MODES,
};

const UpdateSettingsSchema = z.record(z.string(), z.string());

export function createSettingsRouter(ctx: RuntimeContext): Router {
  const router = Router();
  const { db } = ctx;

  function readAllSettings(): Record<string, string> {
    const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
      key: string;
      value: string;
    }>;
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  router.get("/settings", (_req, res) => {
    const settings = readAllSettings();
    res.json(settings);
  });

  router.put("/settings", (req, res) => {
    const parsed = UpdateSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const unknownKeys = Object.keys(parsed.data).filter(k => !VALID_SETTINGS_KEYS.has(k));
    if (unknownKeys.length > 0) {
      return res.status(400).json({ error: "unknown_settings_keys", keys: unknownKeys });
    }

    const invalidValues: Array<{ key: string; value: string; allowed: readonly string[] }> = [];
    for (const [key, value] of Object.entries(parsed.data)) {
      const allowed = SETTINGS_ENUM_VALUES[key];
      if (allowed && !allowed.includes(value)) {
        invalidValues.push({ key, value, allowed });
      }
    }
    if (invalidValues.length > 0) {
      return res.status(400).json({ error: "invalid_settings_values", details: invalidValues });
    }

    const upsert = db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    );
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed.data)) {
      upsert.run(key, value, now);
    }

    const settings = readAllSettings();
    res.json(settings);
  });

  return router;
}
