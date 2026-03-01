import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeContext } from "../types/runtime.js";

const CreateMessageSchema = z.object({
  sender_type: z.enum(["user", "agent", "system"]).default("user"),
  sender_id: z.string().nullish(),
  content: z.string().min(1),
  message_type: z.enum(["chat", "task_assign", "directive", "report", "status_update"]).default("chat"),
  task_id: z.string().nullish(),
});

export function createMessagesRouter(ctx: RuntimeContext): Router {
  const router = Router();
  const { db, ws } = ctx;

  router.get("/messages", (req, res) => {
    const taskId = req.query.task_id as string | undefined;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    if (taskId) {
      const messages = db.prepare(
        "SELECT * FROM messages WHERE task_id = ? ORDER BY created_at DESC LIMIT ?"
      ).all(taskId, limit);
      return res.json(messages);
    }

    const messages = db.prepare(
      "SELECT * FROM messages ORDER BY created_at DESC LIMIT ?"
    ).all(limit);
    res.json(messages);
  });

  router.post("/messages", (req, res) => {
    const parsed = CreateMessageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const id = randomUUID();
    const now = Date.now();
    const { sender_type, sender_id, content, message_type, task_id } = parsed.data;

    db.prepare(
      `INSERT INTO messages (id, sender_type, sender_id, content, message_type, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, sender_type, sender_id ?? null, content, message_type, task_id ?? null, now);

    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    ws.broadcast("message_new", message);
    res.status(201).json(message);
  });

  return router;
}
