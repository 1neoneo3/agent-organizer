import { WebSocket } from "ws";
import { WS_BATCH_INTERVALS, WS_MAX_BATCH_QUEUE } from "../config/runtime.js";
import { recordWsBroadcast } from "../perf/metrics.js";

const PING_INTERVAL_MS = 30_000;

interface BroadcastOptions {
  taskId?: string;
}

export interface WsHub {
  readonly clients: Set<WebSocket>;
  addClient(ws: WebSocket): void;
  removeClient(ws: WebSocket): void;
  subscribeClientToTask(ws: WebSocket, taskId: string): void;
  unsubscribeClientFromTask(ws: WebSocket, taskId: string): void;
  broadcast(type: string, payload: unknown, options?: BroadcastOptions): void;
  dispose(): void;
}

export function createWsHub(): WsHub {
  const clients = new Set<WebSocket>();
  const taskSubscriptions = new WeakMap<WebSocket, Set<string>>();
  const batches = new Map<
    string,
    { queue: Array<{ payload: unknown; taskId?: string }>; timer: ReturnType<typeof setTimeout> }
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
    taskSubscriptions.set(ws, new Set());
    ws.on("pong", () => aliveMap.set(ws, true));
  }

  function addClient(ws: WebSocket): void {
    registerClient(ws);
    clients.add(ws);
  }

  function removeClient(ws: WebSocket): void {
    clients.delete(ws);
    taskSubscriptions.delete(ws);
  }

  function dispose(): void {
    clearInterval(pingTimer);
  }
  // --- end heartbeat ---

  function shouldReceive(ws: WebSocket, taskId?: string): boolean {
    if (!taskId) {
      return true;
    }

    return taskSubscriptions.get(ws)?.has(taskId) ?? false;
  }

  function sendRaw(type: string, payload: unknown, taskId?: string): void {
    const message = JSON.stringify({ type, payload, ts: Date.now() });
    const byteLength = Buffer.byteLength(message);
    let delivered = 0;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN && shouldReceive(ws, taskId)) {
        ws.send(message);
        delivered += 1;
      }
    }
    // Only count an actual broadcast if at least one client received it,
    // so idle-but-connected-less intervals don't bloat the counter.
    if (delivered > 0) {
      recordWsBroadcast(byteLength * delivered);
    }
  }

  function flushBatch(type: string): void {
    const batch = batches.get(type);
    if (!batch || batch.queue.length === 0) return;
    const items = batch.queue.splice(0);
    // Flatten when individual payloads are already arrays. Without this,
    // batching a stream of `[log, log]` payloads would produce the nested
    // form `[[log, log], [log]]`, which clients handling `cli_output`
    // treat as single entries and end up looking at a raw Array as a
    // "log record". Flattening produces a uniform flat array for
    // subscribers, regardless of whether the original broadcasts sent
    // scalars or arrays.
    const flattened = items.flatMap((item) =>
      Array.isArray(item.payload) ? item.payload : [item.payload],
    );
    sendRaw(type, flattened, items[0]?.taskId);
    batches.delete(type);
  }

  function broadcast(type: string, payload: unknown, options?: BroadcastOptions): void {
    const interval = WS_BATCH_INTERVALS[type];
    if (interval == null) {
      sendRaw(type, payload, options?.taskId);
      return;
    }

    const batchKey = options?.taskId ? `${type}:${options.taskId}` : type;
    const existing = batches.get(batchKey);
    if (!existing) {
      // First event: send immediately, open batch window
      sendRaw(type, payload, options?.taskId);
      batches.set(batchKey, {
        queue: [],
        timer: setTimeout(() => flushBatch(batchKey), interval),
      });
      return;
    }

    existing.queue.push({ payload, taskId: options?.taskId });
    if (existing.queue.length > WS_MAX_BATCH_QUEUE) {
      existing.queue.shift(); // shed oldest
    }
  }

  function subscribeClientToTask(ws: WebSocket, taskId: string): void {
    taskSubscriptions.get(ws)?.add(taskId);
  }

  function unsubscribeClientFromTask(ws: WebSocket, taskId: string): void {
    taskSubscriptions.get(ws)?.delete(taskId);
  }

  return { clients, addClient, removeClient, subscribeClientToTask, unsubscribeClientFromTask, broadcast, dispose };
}
