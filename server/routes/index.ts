import { Router } from "express";
import { execSync } from "node:child_process";
import authRouter from "./auth.js";
import { createAgentsRouter } from "./agents.js";
import { createTasksRouter } from "./tasks.js";
import { createMessagesRouter } from "./messages.js";
import { createSettingsRouter } from "./settings.js";
import { createKanbanRouter } from "./integrations/kanban.js";
import { createDirectivesRouter } from "./directives.js";
import type { RuntimeContext } from "../types/runtime.js";

export function mountRoutes(ctx: RuntimeContext): Router {
  const router = Router();

  // Health check
  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      cache: ctx.cache.isConnected ? "connected" : "disconnected",
    });
  });

  // CLI status detection
  router.get("/cli-status", (_req, res) => {
    const clis: Record<string, boolean> = {};
    for (const cli of ["claude", "codex", "gemini"] as const) {
      try {
        execSync(`which ${cli}`, { stdio: "ignore" });
        clis[cli] = true;
      } catch {
        clis[cli] = false;
      }
    }
    res.json(clis);
  });

  // Mount sub-routers
  router.use("/", authRouter);
  router.use("/", createAgentsRouter(ctx));
  router.use("/", createTasksRouter(ctx));
  router.use("/", createMessagesRouter(ctx));
  router.use("/", createSettingsRouter(ctx));
  router.use("/", createKanbanRouter(ctx));
  router.use("/", createDirectivesRouter(ctx));

  return router;
}
