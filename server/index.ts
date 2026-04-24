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
import { createWebhooksRouter } from "./routes/webhooks.js";
import { mountStatic } from "./static-handlers.js";
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
// Webhooks must be mounted BEFORE express.json() so the raw body is
// preserved for HMAC signature verification. The router pulls its own
// express.raw() body parser per-route.
app.use("/webhooks", createWebhooksRouter(ctx));

app.use(express.json());
app.use("/api", authMiddleware);

// Routes
app.use("/api", mountRoutes(ctx));

// Serve static files from dist/ when it exists
const distPath = resolve(__dirname, "..", "dist");
mountStatic(app, distPath);

// HTTP server
const server = createServer(app);

// WebSocket
//
// `perMessageDeflate` turns on RFC-7692 per-message compression. For our
// workload (JSON-encoded task updates + log batches, typically 2–300KB
// per broadcast and occasionally much larger on initial task sync) this
// typically saves 50–70% of wire bytes at the cost of a small CPU spike
// per message. We deliberately tune away from the library defaults:
//
//   - `threshold: 1024` so scalar status pings stay uncompressed (the
//     deflate overhead actually makes tiny messages *larger*)
//   - `level: 1` for zlib, which is the fastest compression setting and
//     already captures the bulk of the savings on JSON. Levels 6+ give
//     only a few percent extra while burning many times the CPU.
//   - `concurrencyLimit: 10` to bound the number of parallel deflate
//     operations across connected clients, so a flood of broadcasts to
//     N clients can never stall the event loop.
//
// Clients need no changes — browsers negotiate deflate transparently.
const wss = new WebSocketServer({
  server,
  path: "/ws",
  perMessageDeflate: {
    zlibDeflateOptions: { level: 1 },
    threshold: 1024,
    concurrencyLimit: 10,
  },
});
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

// Fatal error safety net: log the incident and exit cleanly so the process
// supervisor (systemd Restart=always) can bring us back up. Without this,
// an unhandled exception inside a setTimeout / detached promise leaves the
// parent supervisor blind to the failure.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
  process.exit(1);
});

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
