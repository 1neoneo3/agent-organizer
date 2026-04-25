import express, { Router } from "express";
import { buildTaskSummaryUpdate } from "../ws/update-payloads.js";
import type { RuntimeContext, Task } from "../types/runtime.js";
import { GITHUB_WEBHOOK_SECRET } from "../config/runtime.js";
import { dispatchAutoStartableTasks } from "../dispatch/auto-dispatcher.js";
import {
  handleMergedPrEvent,
  isPullRequestMergedEvent,
  verifyGithubSignature,
} from "../webhooks/github.js";

/**
 * GitHub webhook router. Mounted at `/webhooks` by index.ts OUTSIDE the
 * `/api` prefix so it does not go through `authMiddleware` — GitHub's
 * outbound webhooks sign payloads with HMAC, not bearer tokens.
 *
 * Uses `express.raw` so we can verify the HMAC against the exact bytes
 * GitHub sent (JSON.stringify round-trips would break the signature).
 */
export function createWebhooksRouter(ctx: RuntimeContext): Router {
  const router = Router();

  router.post(
    "/github",
    express.raw({ type: "application/json", limit: "2mb" }),
    (req, res) => {
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
      const signature = req.header("x-hub-signature-256") ?? req.header("X-Hub-Signature-256");
      if (!verifyGithubSignature(GITHUB_WEBHOOK_SECRET, rawBody, signature ?? undefined)) {
        return res.status(401).json({ error: "invalid_signature" });
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody.toString("utf8") || "{}");
      } catch {
        return res.status(400).json({ error: "invalid_json" });
      }

      const event = req.header("x-github-event") ?? req.header("X-GitHub-Event");
      if (!isPullRequestMergedEvent(event ?? undefined, payload)) {
        return res.status(204).end();
      }

      const result = handleMergedPrEvent(ctx.db, payload, {
        log: (taskId, message) => {
          ctx.db
            .prepare(
              "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
            )
            .run(taskId, message);
        },
        broadcastTaskUpdate: (taskId) => {
          const task = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
          if (task) ctx.ws.broadcast("task_update", buildTaskSummaryUpdate(task));
        },
        // Fire the auto-dispatcher immediately so downstream tasks that
        // were waiting on this one start without waiting for the next
        // 60s polling tick.
        onCompletion: () => {
          dispatchAutoStartableTasks(ctx.db, ctx.ws);
        },
      });

      return res.status(200).json({
        matched: result.matched.length,
        completed: result.completed_task_ids.length,
        tasks: result.matched,
      });
    },
  );

  return router;
}
