import { Router } from "express";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeContext, Directive } from "../types/runtime.js";
import { decomposeDirective, getDecomposeLogs } from "../spawner/decomposer.js";
import {
  CONTROLLER_STAGES,
  advanceControllerDirective,
  isControllerModeEnabled,
  reconcileControllerDirective,
  splitDirectiveIntoControllerTasks,
  summarizeControllerDirective,
} from "../controller/orchestrator.js";

const CreateDirectiveSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  issued_by_type: z.enum(["user", "agent"]).default("user"),
  issued_by_id: z.string().nullish(),
  project_path: z.string().nullish(),
  auto_decompose: z.boolean().default(false),
  controller_mode: z.boolean().default(false),
  controller_stage: z.enum(CONTROLLER_STAGES).nullish(),
});

const UpdateDirectiveSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  status: z.enum(["pending", "decomposing", "active", "completed", "cancelled"]).optional(),
  project_path: z.string().nullish(),
  controller_mode: z.boolean().optional(),
  controller_stage: z.enum([...CONTROLLER_STAGES, "blocked", "completed"] as const).nullish(),
});

const ControllerChildSchema = z.object({
  task_number: z.string().min(1).max(32),
  title: z.string().min(1).max(500),
  description: z.string().nullish(),
  controller_stage: z.enum(CONTROLLER_STAGES),
  write_scope: z.array(z.string().min(1)).default([]),
  depends_on: z.array(z.string().min(1)).default([]),
  priority: z.number().int().min(0).max(10).default(0),
  task_size: z.enum(["small", "medium", "large"]).default("small"),
});

const ControllerSplitSchema = z.object({
  children: z.array(ControllerChildSchema).min(1).max(30),
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
    const { title, content, issued_by_type, issued_by_id, project_path, auto_decompose, controller_mode, controller_stage } = parsed.data;

    db.prepare(
      `INSERT INTO directives (id, title, content, issued_by_type, issued_by_id, status, project_path, controller_mode, controller_stage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
    ).run(id, title, content, issued_by_type, issued_by_id ?? null, project_path ?? null, controller_mode ? 1 : 0, controller_stage ?? null, now, now);

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
        if (key === "controller_mode") {
          fields.push(`${key} = ?`);
          values.push(value ? 1 : 0);
        } else {
          fields.push(`${key} = ?`);
          values.push((value ?? null) as string | number | null);
        }
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

  // Get decompose logs (buffered) for a directive
  router.get("/directives/:id/decompose-logs", (req, res) => {
    const logs = getDecomposeLogs(req.params.id);
    res.json(logs);
  });

  // Get tasks linked to a directive
  router.get("/directives/:id/tasks", (req, res) => {
    const directive = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id);
    if (!directive) return res.status(404).json({ error: "not_found" });

    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE directive_id = ? ORDER BY task_number ASC, priority DESC, created_at ASC"
    ).all(req.params.id);
    res.json(tasks);
  });

  router.post("/directives/:id/controller/split", (req, res) => {
    if (!isControllerModeEnabled(db)) {
      return res.status(403).json({ error: "controller_mode_disabled" });
    }
    const directive = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id) as Directive | undefined;
    if (!directive) return res.status(404).json({ error: "not_found" });
    if (directive.status === "cancelled") return res.status(409).json({ error: "directive_cancelled" });
    if (directive.status === "completed") return res.status(409).json({ error: "directive_completed" });

    const existingControllerTasks = db.prepare(
      "SELECT id FROM tasks WHERE directive_id = ? AND controller_stage IS NOT NULL LIMIT 1",
    ).get(directive.id);
    if (existingControllerTasks) {
      return res.status(409).json({ error: "controller_tasks_already_exist" });
    }

    const parsed = ControllerSplitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const result = splitDirectiveIntoControllerTasks(ctx, directive, parsed.data.children);
      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: "invalid_controller_split", message });
    }
  });

  router.post("/directives/:id/controller/reconcile", (req, res) => {
    if (!isControllerModeEnabled(db)) {
      return res.status(403).json({ error: "controller_mode_disabled" });
    }
    const directive = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id) as Directive | undefined;
    if (!directive) return res.status(404).json({ error: "not_found" });
    const updated = reconcileControllerDirective(ctx, directive.id);
    res.json({ directive: updated, summary: summarizeControllerDirective(db, directive.id) });
  });

  router.post("/directives/:id/advance-stage", (req, res) => {
    if (!isControllerModeEnabled(db)) {
      return res.status(403).json({ error: "controller_mode_disabled" });
    }
    const directive = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id) as Directive | undefined;
    if (!directive) return res.status(404).json({ error: "not_found" });
    const result = advanceControllerDirective(ctx, directive.id);
    if (!result.advanced) {
      return res.status(409).json({
        error: "stage_advance_blocked",
        blocked_reason: result.blocked_reason,
        directive: result.directive,
        summary: summarizeControllerDirective(db, directive.id),
      });
    }
    res.json({ ...result, summary: summarizeControllerDirective(db, directive.id) });
  });

  router.get("/directives/:id/controller", (req, res) => {
    const directive = db.prepare("SELECT * FROM directives WHERE id = ?").get(req.params.id);
    if (!directive) return res.status(404).json({ error: "not_found" });
    res.json(summarizeControllerDirective(db, req.params.id));
  });

  // Get plan document for a directive
  router.get("/directives/:id/plan", (req, res) => {
    const planPath = join(process.cwd(), "data", "plans", `${req.params.id}.md`);
    if (!existsSync(planPath)) {
      return res.status(404).json({ error: "plan_not_found" });
    }
    const content = readFileSync(planPath, "utf-8");
    res.json({ directive_id: req.params.id, content });
  });

  return router;
}
