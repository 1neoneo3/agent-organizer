import { WebSocket } from "ws";
import { WS_BATCH_INTERVALS, WS_MAX_BATCH_QUEUE } from "../config/runtime.js";

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

export interface WsHub {
  readonly clients: Set<WebSocket>;
  broadcast(type: string, payload: unknown): void;
  dispose(): void;
}

export function createWsHub(): WsHub {
  const clients = new Set<WebSocket>();
  const batches = new Map<
    string,
    { queue: unknown[]; timer: ReturnType<typeof setTimeout> }
  >();

  // --- ping/pong heartbeat ---
  const aliveMap = new WeakMap<WebSocket, boolean>();

  const pingTimer = setInterval(() => {
    for (const ws of clients) {
      if (aliveMap.get(ws) === false) {
        // No pong received since last ping — terminate
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      aliveMap.set(ws, false);
      ws.ping();
    }
  }, PING_INTERVAL_MS);

  function registerClient(ws: WebSocket): void {
    aliveMap.set(ws, true);
    ws.on("pong", () => aliveMap.set(ws, true));
  }

  function dispose(): void {
    clearInterval(pingTimer);
  }
  // --- end heartbeat ---

  function sendRaw(type: string, payload: unknown): void {
    const message = JSON.stringify({ type, payload, ts: Date.now() });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  function flushBatch(type: string): void {
    const batch = batches.get(type);
    if (!batch || batch.queue.length === 0) return;
    const items = batch.queue.splice(0);
    sendRaw(type, items);
    batches.delete(type);
  }

  function broadcast(type: string, payload: unknown): void {
    const interval = WS_BATCH_INTERVALS[type];
    if (interval == null) {
      sendRaw(type, payload);
      return;
    }

    const existing = batches.get(type);
    if (!existing) {
      // First event: send immediately, open batch window
      sendRaw(type, payload);
      batches.set(type, {
        queue: [],
        timer: setTimeout(() => flushBatch(type), interval),
      });
      return;
    }

    existing.queue.push(payload);
    if (existing.queue.length > WS_MAX_BATCH_QUEUE) {
      existing.queue.shift(); // shed oldest
    }
  }

  // Expose registerClient via the clients Set add
  const clientsProxy = new Set<WebSocket>();
  const originalAdd = clientsProxy.add.bind(clientsProxy);
  const originalDelete = clientsProxy.delete.bind(clientsProxy);
  clientsProxy.add = (ws: WebSocket) => {
    registerClient(ws);
    return originalAdd(ws);
  };
  clientsProxy.delete = (ws: WebSocket) => {
    return originalDelete(ws);
  };

  return { clients: clientsProxy, broadcast, dispose };
}
