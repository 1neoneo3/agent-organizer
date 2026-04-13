import { Router } from "express";
import { z } from "zod";
import type { RuntimeContext } from "../types/runtime.js";
import { SETTINGS_DEFAULTS } from "../config/runtime.js";

const VALID_SETTINGS_KEYS = new Set([
  ...Object.keys(SETTINGS_DEFAULTS),
  "default_enable_ci_check",
  "default_enable_human_review",
  "explore_phase",
  "github_write_mode",
  "github_write_allowed_repos",
  "github_write_token_passthrough",
  "auto_done",
]);

const UpdateSettingsSchema = z.record(z.string(), z.string());

export function createSettingsRouter(ctx: RuntimeContext): Router {
  const router = Router();
  const { db, cache } = ctx;

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

  router.get("/settings", async (_req, res) => {
    const cached = await cache.get<Record<string, string>>("settings:all");
    if (cached) return res.json(cached);

    const settings = readAllSettings();
    await cache.set("settings:all", settings, 300);
    res.json(settings);
  });

  router.put("/settings", async (req, res) => {
    const parsed = UpdateSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const unknownKeys = Object.keys(parsed.data).filter(k => !VALID_SETTINGS_KEYS.has(k));
    if (unknownKeys.length > 0) {
      return res.status(400).json({ error: "unknown_settings_keys", keys: unknownKeys });
    }

    const upsert = db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    );
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed.data)) {
      upsert.run(key, value, now);
    }

    const settings = readAllSettings();
    await cache.del("settings:all");
    res.json(settings);
  });

  return router;
}
