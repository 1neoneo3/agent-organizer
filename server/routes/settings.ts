import { Router } from "express";
import { z } from "zod";
import type { RuntimeContext } from "../types/runtime.js";

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
