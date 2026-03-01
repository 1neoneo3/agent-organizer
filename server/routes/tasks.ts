import { Router } from "express";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeContext, Agent, Task } from "../types/runtime.js";
import { spawnAgent, killAgent } from "../spawner/process-manager.js";
import { prettyStreamJson } from "../spawner/pretty-stream-json.js";

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().nullish(),
  assigned_agent_id: z.string().nullish(),
  project_path: z.string().nullish(),
  priority: z.number().int().min(0).max(10).default(0),
  task_size: z.enum(["small", "medium", "large"]).default("small"),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  assigned_agent_id: z.string().nullish(),
  project_path: z.string().nullish(),
  status: z.enum(["inbox", "in_progress", "self_review", "pr_review", "done", "cancelled"]).optional(),
  priority: z.number().int().min(0).max(10).optional(),
  task_size: z.enum(["small", "medium", "large"]).optional(),
  result: z.string().nullish(),
});

export function createTasksRouter(ctx: RuntimeContext): Router {
  const router = Router();
  const { db, ws } = ctx;

  router.get("/tasks", (req, res) => {
    const status = req.query.status as string | undefined;
    if (status) {
      const tasks = db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at DESC").all(status);
      return res.json(tasks);
    }
    const tasks = db.prepare("SELECT * FROM tasks ORDER BY priority DESC, created_at DESC").all();
    res.json(tasks);
  });

  router.get("/tasks/:id", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!task) return res.status(404).json({ error: "not_found" });
    res.json(task);
  });

  router.post("/tasks", (req, res) => {
    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const id = randomUUID();
    const now = Date.now();
    const { title, description, assigned_agent_id, project_path, priority, task_size } = parsed.data;

    db.prepare(
      `INSERT INTO tasks (id, title, description, assigned_agent_id, project_path, priority, task_size, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, title, description ?? null, assigned_agent_id ?? null, project_path ?? null, priority, task_size, now, now);

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    ws.broadcast("task_update", task);
    res.status(201).json(task);
  });

  router.put("/tasks/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "not_found" });

    const parsed = UpdateTaskSchema.safeParse(req.body);
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

    if (updates.status === "done" || updates.status === "cancelled") {
      fields.push("completed_at = ?");
      values.push(now);
    }

    fields.push("updated_at = ?");
    values.push(now);
    values.push(req.params.id);

    db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...(values as Array<string | number | null>));
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    ws.broadcast("task_update", task);
    res.json(task);
  });

  router.delete("/tasks/:id", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (task.status === "in_progress") {
      killAgent(task.id);
    }
    db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
    res.json({ deleted: true });
  });

  // Run a task (spawn agent)
  router.post("/tasks/:id/run", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (task.status === "in_progress") return res.status(409).json({ error: "already_running" });

    const agentId = task.assigned_agent_id ?? (req.body as { agent_id?: string }).agent_id;
    if (!agentId) return res.status(400).json({ error: "no_agent_assigned" });

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Agent | undefined;
    if (!agent) return res.status(404).json({ error: "agent_not_found" });
    if (agent.status === "working") return res.status(409).json({ error: "agent_busy" });

    // Assign agent if not already
    if (!task.assigned_agent_id) {
      db.prepare("UPDATE tasks SET assigned_agent_id = ? WHERE id = ?").run(agentId, task.id);
    }

    const result = spawnAgent(db, ws, agent, { ...task, assigned_agent_id: agentId });
    res.json({ started: true, pid: result.pid });
  });

  // Stop a running task
  router.post("/tasks/:id/stop", (req, res) => {
    const killed = killAgent(req.params.id, "user_stop");
    if (!killed) return res.status(404).json({ error: "not_running" });

    const now = Date.now();
    db.prepare("UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, req.params.id);

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (task?.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?").run(now, task.assigned_agent_id);
      ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
    }

    ws.broadcast("task_update", { id: req.params.id, status: "cancelled" });
    res.json({ stopped: true });
  });

  // Get task logs
  router.get("/tasks/:id/logs", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const offset = Number(req.query.offset ?? 0);
    const logs = db.prepare(
      "SELECT * FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ? OFFSET ?"
    ).all(req.params.id, limit, offset);
    res.json(logs);
  });

  // Terminal view: pretty-printed log file + DB logs
  router.get("/tasks/:id/terminal", (req, res) => {
    const maxLines = Math.min(Number(req.query.lines ?? 2000), 10000);
    const pretty = req.query.pretty === "1";

    const logPath = join("data", "logs", `${req.params.id}.log`);
    let rawText = "";
    let fileExists = false;

    if (existsSync(logPath)) {
      fileExists = true;
      try {
        rawText = readFileSync(logPath, "utf-8");
      } catch {
        rawText = "";
      }
    }

    // Tail to maxLines
    const allLines = rawText.split("\n");
    if (allLines.length > maxLines) {
      rawText = allLines.slice(-maxLines).join("\n");
    }

    const text = pretty ? prettyStreamJson(rawText) : rawText;

    // Also fetch recent task_logs from DB for system/stderr entries
    const taskLogs = db.prepare(
      "SELECT kind, message, created_at FROM task_logs WHERE task_id = ? AND kind IN ('system', 'stderr') ORDER BY id DESC LIMIT 50"
    ).all(req.params.id) as Array<{ kind: string; message: string; created_at: number }>;

    res.json({ ok: true, exists: fileExists, text, task_logs: taskLogs });
  });

  // CEO Feedback: send directive to an in-progress task
  router.post("/tasks/:id/feedback", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (task.status !== "in_progress") {
      return res.status(409).json({ error: "task_not_in_progress", current_status: task.status });
    }

    const schema = z.object({ content: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { content } = parsed.data;
    const now = Date.now();
    const timestamp = new Date(now).toISOString();

    // 1. Append to feedback file
    const feedbackDir = join("data", "feedback");
    mkdirSync(feedbackDir, { recursive: true });
    const feedbackPath = join(feedbackDir, `${task.id}.md`);
    appendFileSync(feedbackPath, `\n---\n## CEO Feedback (${timestamp})\n\n${content}\n`, "utf-8");

    // 2. Save as message
    const msgId = randomUUID();
    db.prepare(
      `INSERT INTO messages (id, sender_type, sender_id, content, message_type, task_id, created_at)
       VALUES (?, 'user', NULL, ?, 'directive', ?, ?)`
    ).run(msgId, content, task.id, now);

    // 3. Add system log
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `CEO feedback received: ${content.slice(0, 200)}`);

    // 4. Broadcast
    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(msgId);
    ws.broadcast("message_new", message);
    ws.broadcast("cli_output", { task_id: task.id, kind: "system", message: `[CEO Feedback] ${content}` });

    res.json({ sent: true, feedback_path: feedbackPath });
  });

  return router;
}
