import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { WebSocketServer, type WebSocket } from "ws";
import { initializeDb } from "./db/runtime.js";
import { createWsHub } from "./ws/hub.js";
import { mountRoutes } from "./routes/index.js";
import { authMiddleware } from "./security/auth.js";
import { startOrphanRecovery } from "./lifecycle/jobs.js";
import { PORT, IS_DEV, SESSION_AUTH_TOKEN } from "./config/runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bootstrap
const db = initializeDb();
const wsHub = createWsHub();
const ctx = { db, ws: wsHub };

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
  wsHub.clients.add(ws);
  ws.on("close", () => wsHub.clients.delete(ws));
  ws.on("error", () => wsHub.clients.delete(ws));
});

// Lifecycle jobs
startOrphanRecovery(db, wsHub);

// Start
server.listen(PORT, () => {
  console.log(`Agent Organizer running on http://localhost:${PORT}`);
  if (IS_DEV) {
    console.log(`Auth token: ${SESSION_AUTH_TOKEN}`);
  }
});
