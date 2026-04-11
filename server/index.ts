import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { WebSocketServer, type WebSocket } from "ws";
import { initializeDb } from "./db/runtime.js";
import { createWsHub } from "./ws/hub.js";
import { createRedisClient, createCacheService } from "./cache/index.js";
import { mountRoutes } from "./routes/index.js";
import { authMiddleware } from "./security/auth.js";
import { startOrphanRecovery } from "./lifecycle/jobs.js";
import { restorePendingInteractivePrompts } from "./spawner/process-manager.js";
import { startTelegramControlPoller } from "./notify/telegram-control.js";
import { startAutoDispatchScheduler } from "./dispatch/auto-dispatcher.js";
import { startGithubIssueSync } from "./integrations/github-sync.js";
import { isPerfLogEnabled, startPerfReporter } from "./perf/metrics.js";
import { initHeartbeatManager } from "./spawner/heartbeat-manager.js";
import {
  PORT,
  IS_DEV,
  SESSION_AUTH_TOKEN,
} from "./config/runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bootstrap
const db = initializeDb();
const wsHub = createWsHub();
const redis = createRedisClient();
const cache = createCacheService(redis);
const ctx = { db, ws: wsHub, cache };

const app = express();

// Middleware
app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["content-type", "authorization", "x-csrf-token"],
}));
app.use(express.json());
app.use("/api", authMiddleware);

// Routes
app.use("/api", mountRoutes(ctx));

// Serve static files from dist/ when it exists
const distPath = resolve(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(resolve(distPath, "index.html"));
});

// HTTP server
const server = createServer(app);

// WebSocket
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws: WebSocket) => {
  wsHub.addClient(ws);
  ws.on("message", (message) => {
    try {
      const parsed = JSON.parse(message.toString()) as { type?: string; taskId?: string };
      if (!parsed.taskId) return;

      if (parsed.type === "subscribe_task") {
        wsHub.subscribeClientToTask(ws, parsed.taskId);
      } else if (parsed.type === "unsubscribe_task") {
        wsHub.unsubscribeClientFromTask(ws, parsed.taskId);
      }
    } catch {
      // ignore malformed client messages
    }
  });
  ws.on("close", () => wsHub.removeClient(ws));
  ws.on("error", () => wsHub.removeClient(ws));
});

// Restore interactive prompts from DB and start lifecycle jobs
restorePendingInteractivePrompts(db);
const heartbeatManager = initHeartbeatManager(db);
heartbeatManager.start();
startOrphanRecovery(db, wsHub, cache);
startGithubIssueSync(db, wsHub, cache);
startAutoDispatchScheduler(db, wsHub, cache);

// Start
server.listen(PORT, () => {
  console.log(`Agent Organizer running on http://localhost:${PORT}`);
  startTelegramControlPoller();
  if (IS_DEV) {
    console.log(`Auth token: ${SESSION_AUTH_TOKEN}`);
  }
  if (isPerfLogEnabled()) {
    startPerfReporter();
    console.log(`[perf] perf logging enabled (AO_PERF_LOG=1, interval 5s)`);
  }
});
