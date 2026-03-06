import { useEffect, useRef, useState, useCallback } from "react";
import { bootstrapSession } from "../api/index.js";
import type { WSEventType } from "../types/index.js";

type Listener = (payload: unknown) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const DISCONNECT_GRACE_MS = 3000;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<WSEventType, Set<Listener>>>(new Map());
  const taskSubscriptionsRef = useRef<Map<string, number>>(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let alive = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let graceTimer: ReturnType<typeof setTimeout>;
    let attempt = 0;

    async function connect() {
      if (!alive) return;

      try {
        const ok = await bootstrapSession();
        if (!ok) {
          scheduleReconnect();
          return;
        }
      } catch {
        scheduleReconnect();
        return;
      }

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/ws`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!alive) return;
        attempt = 0;
        clearTimeout(graceTimer);
        setConnected(true);
        for (const taskId of taskSubscriptionsRef.current.keys()) {
          ws.send(JSON.stringify({ type: "subscribe_task", taskId }));
        }
      };

      ws.onclose = () => {
        if (!alive) return;
        // Grace period before showing "Disconnected" — allows quick reconnects
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => {
          if (alive) setConnected(false);
        }, DISCONNECT_GRACE_MS);
        scheduleReconnect();
      };

      ws.onerror = () => ws.close();

      ws.onmessage = (e) => {
        if (!alive) return;
        try {
          const evt = JSON.parse(e.data as string);
          const listeners = listenersRef.current.get(evt.type);
          if (listeners) {
            for (const fn of listeners) fn(evt.payload);
          }
        } catch {
          // ignore parse errors
        }
      };
    }

    function scheduleReconnect() {
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(1.5, attempt), RECONNECT_MAX_MS);
      attempt++;
      reconnectTimer = setTimeout(connect, delay);
    }

    void connect();

    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      clearTimeout(graceTimer);
      wsRef.current?.close();
    };
  }, []);

  const on = useCallback((type: WSEventType, fn: Listener) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type)!.add(fn);
    return () => {
      listenersRef.current.get(type)?.delete(fn);
    };
  }, []);

  const subscribeTask = useCallback((taskId: string) => {
    const count = taskSubscriptionsRef.current.get(taskId) ?? 0;
    taskSubscriptionsRef.current.set(taskId, count + 1);

    if (count === 0 && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe_task", taskId }));
    }

    return () => {
      const current = taskSubscriptionsRef.current.get(taskId) ?? 0;
      if (current <= 1) {
        taskSubscriptionsRef.current.delete(taskId);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "unsubscribe_task", taskId }));
        }
        return;
      }

      taskSubscriptionsRef.current.set(taskId, current - 1);
    };
  }, []);

  return { connected, on, subscribeTask };
}
