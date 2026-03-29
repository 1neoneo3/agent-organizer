import { Router } from "express";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RuntimeContext, Task } from "../../types/runtime.js";

export function createKanbanRouter(ctx: RuntimeContext): Router {
  const router = Router();
  const { db } = ctx;

  const kanbanScript = join(homedir(), ".claude", "scripts", "kanban-cli.sh");

  router.post("/integrations/kanban/sync", (req, res) => {
    const { task_id, action } = req.body as { task_id?: string; action?: string };

    if (!task_id) return res.status(400).json({ error: "task_id required" });

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "task_not_found" });

    const kanbanAction = action ?? mapStatusToKanbanAction(task.status);
    if (!kanbanAction) return res.json({ skipped: true, reason: "no_action_for_status" });

    const args = [kanbanAction, task.title];

    execFile(kanbanScript, args, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        return res.status(500).json({ error: "kanban_sync_failed", detail: stderr || error.message });
      }
      res.json({ synced: true, output: stdout.trim() });
    });
  });

  return router;
}

function mapStatusToKanbanAction(status: string): string | null {
  switch (status) {
    case "inbox":
      return "add";
    case "in_progress":
      return "doing";
    case "qa_testing":
    case "pr_review":
    case "self_review":
      return "review";
    case "done":
      return "done";
    default:
      return null;
  }
}
