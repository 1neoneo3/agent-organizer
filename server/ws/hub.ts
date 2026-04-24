import { WebSocket } from "ws";
import { WS_BATCH_INTERVALS, WS_MAX_BATCH_QUEUE } from "../config/runtime.js";
import { recordWsBroadcast } from "../perf/metrics.js";

const PING_INTERVAL_MS = 30_000;

const DEDUP_TYPES = new Set(["task_update", "agent_status"]);
const COALESCE_FLUSH_TYPES = new Set(["task_update", "agent_status"]);

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

function extractEntityId(payload: unknown): string | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "id" in payload) {
    return String((payload as Record<string, unknown>).id);
  }
  return null;
}

export function createWsHub(): WsHub {
  const clients = new Set<WebSocket>();
  const taskSubscriptions = new WeakMap<WebSocket, Set<string>>();
  const batches = new Map<
    string,
    { type: string; queue: Array<{ payload: unknown; taskId?: string }>; timer: ReturnType<typeof setTimeout> }
  >();
  const lastDelivered = new Map<string, string>();

  // --- ping/pong heartbeat ---
  const aliveMap = new WeakMap<WebSocket, boolean>();

  const pingTimer = setInterval(() => {
    for (const ws of clients) {
      if (aliveMap.get(ws) === false) {
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
    for (const batch of batches.values()) {
      clearTimeout(batch.timer);
    }
    batches.clear();
  }
  // --- end heartbeat ---

  function shouldReceive(ws: WebSocket, taskId?: string): boolean {
    if (!taskId) {
      return true;
    }

    return taskSubscriptions.get(ws)?.has(taskId) ?? false;
  }

  function sendRaw(type: string, payload: unknown, taskId?: string): void {
    let dedupKey: string | null = null;
    let payloadHash: string | null = null;
    if (DEDUP_TYPES.has(type)) {
      const entityId = extractEntityId(payload);
      if (entityId) {
        dedupKey = `${type}:${entityId}`;
        payloadHash = JSON.stringify(payload);
        if (lastDelivered.get(dedupKey) === payloadHash) {
          return;
        }
      }
    }

    const message = JSON.stringify({ type, payload, ts: Date.now() });
    const byteLength = Buffer.byteLength(message);
    let delivered = 0;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN && shouldReceive(ws, taskId)) {
        ws.send(message);
        delivered += 1;
      }
    }
    if (delivered > 0) {
      recordWsBroadcast(byteLength * delivered);
      if (dedupKey && payloadHash) {
        lastDelivered.set(dedupKey, payloadHash);
        if (lastDelivered.size > 2000) {
          lastDelivered.delete(lastDelivered.keys().next().value!);
        }
      }
    }
  }

  function flushBatch(batchKey: string): void {
    const batch = batches.get(batchKey);
    if (!batch) return;
    if (batch.queue.length > 0) {
      const items = batch.queue.splice(0);

      if (COALESCE_FLUSH_TYPES.has(batch.type)) {
        for (const item of items) {
          sendRaw(batch.type, item.payload, item.taskId);
        }
      } else {
        const flattened = items.flatMap((item) =>
          Array.isArray(item.payload) ? item.payload : [item.payload],
        );
        sendRaw(batch.type, flattened, items[0]?.taskId);
      }
    }
    batches.delete(batchKey);
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
      sendRaw(type, payload, options?.taskId);
      batches.set(batchKey, {
        type,
        queue: [],
        timer: setTimeout(() => flushBatch(batchKey), interval),
      });
      return;
    }

    if (COALESCE_FLUSH_TYPES.has(type)) {
      const entityId = extractEntityId(payload);
      if (entityId) {
        const idx = existing.queue.findIndex(
          (item) => extractEntityId(item.payload) === entityId,
        );
        if (idx >= 0) {
          existing.queue[idx] = { payload, taskId: options?.taskId };
          return;
        }
      }
    }

    existing.queue.push({ payload, taskId: options?.taskId });
    if (existing.queue.length > WS_MAX_BATCH_QUEUE) {
      existing.queue.shift();
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
