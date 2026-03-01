import { WebSocket } from "ws";
import { WS_BATCH_INTERVALS, WS_MAX_BATCH_QUEUE } from "../config/runtime.js";

export interface WsHub {
  readonly clients: Set<WebSocket>;
  broadcast(type: string, payload: unknown): void;
}

export function createWsHub(): WsHub {
  const clients = new Set<WebSocket>();
  const batches = new Map<
    string,
    { queue: unknown[]; timer: ReturnType<typeof setTimeout> }
  >();

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

  return { clients, broadcast };
}
