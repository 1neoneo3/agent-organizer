import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeContext, Directive } from "../types/runtime.js";
import { decomposeDirective } from "../spawner/decomposer.js";

const CreateDirectiveSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  issued_by_type: z.enum(["user", "agent"]).default("user"),
  issued_by_id: z.string().nullish(),
  project_path: z.string().nullish(),
  auto_decompose: z.boolean().default(false),
});

const UpdateDirectiveSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  status: z.enum(["pending", "decomposing", "active", "completed", "cancelled"]).optional(),
  project_path: z.string().nullish(),
});

export function createDirectivesRouter(ctx: RuntimeContext): Router {
  const router = Router();
  const { db, ws } = ctx;

  // List directives
  router.get("/directives", (req, res) => {
    const status = req.query.status as string | undefined;
    if (status) {
      const rows = db.prepare("SELECT * FROM directives WHERE status = ? ORDER BY created_at DESC").all(status);
      return res.json(rows);
    }
    const rows = db.prepare("SELECT * FROM directives ORDER BY created_at DESC").all();
    res.json(rows);
  });

  // Get single directive
  router.get("/directives/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  });

  // Create directive
  router.post("/directives", async (req, res) => {
    const parsed = CreateDirectiveSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const id = randomUUID();
    const now = Date.now();
    const { title, content, issued_by_type, issued_by_id, project_path, auto_decompose } = parsed.data;

    db.prepare(
      `INSERT INTO directives (id, title, content, issued_by_type, issued_by_id, status, project_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(id, title, content, issued_by_type, issued_by_id ?? null, project_path ?? null, now, now);

    const directive = db.prepare("SELECT * FROM directives WHERE id = ?").get(id) as unknown as Directive;
    ws.broadcast("directive_update", directive);

    if (auto_decompose) {
      // Fire-and-forget decomposition
      decomposeDirective(ctx, directive).catch((err) => {
        console.error(`Decompose failed for directive ${id}:`, err);
      });
    }

    res.status(201).json(directive);
  });

  // Update directive
  router.put("/directives/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "not_found" });

    const parsed = UpdateDirectiveSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const updates = parsed.data;
    const now = Date.now();
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push((value ?? null) as string | number | null);
      }
    }
    fields.push("updated_at = ?");
    values.push(now);
    values.push(req.params.id);

    db.prepare(`UPDATE directives SET ${fields.join(", ")} WHERE id = ?`).run(...(values as Array<string | number | null>));
    const directive = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id);
    ws.broadcast("directive_update", directive);
    res.json(directive);
  });

  // Delete directive
  router.delete("/directives/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "not_found" });

    db.prepare("DELETE FROM directives WHERE id = ?").run(req.params.id);
    res.json({ deleted: true });
  });

  // Trigger decomposition
  router.post("/directives/:id/decompose", async (req, res) => {
    const directive = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id) as Directive | undefined;
    if (!directive) return res.status(404).json({ error: "not_found" });
    if (directive.status !== "pending") {
      return res.status(409).json({ error: "directive_not_pending", current_status: directive.status });
    }

    // Start decomposition asynchronously
    decomposeDirective(ctx, directive).catch((err) => {
      console.error(`Decompose failed for directive ${directive.id}:`, err);
    });

    res.json({ started: true, directive_id: directive.id });
  });

  // Get tasks linked to a directive
  router.get("/directives/:id/tasks", (req, res) => {
    const directive = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id);
    if (!directive) return res.status(404).json({ error: "not_found" });

    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE directive_id = ? ORDER BY priority DESC, created_at ASC"
    ).all(req.params.id);
    res.json(tasks);
  });

  return router;
}
