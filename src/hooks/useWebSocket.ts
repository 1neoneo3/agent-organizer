import { useEffect, useRef, useState, useCallback } from "react";
import { bootstrapSession } from "../api/index.js";
import type { WSEventType } from "../types/index.js";

type Listener = (payload: unknown) => void;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<WSEventType, Set<Listener>>>(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let alive = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    async function connect() {
      if (!alive) return;

      try {
        const ok = await bootstrapSession();
        if (!ok) {
          reconnectTimer = setTimeout(connect, 2000);
          return;
        }
      } catch {
        reconnectTimer = setTimeout(connect, 2000);
        return;
      }

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/ws`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (alive) setConnected(true);
      };

      ws.onclose = () => {
        if (!alive) return;
        setConnected(false);
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => ws.close();

      ws.onmessage = (e) => {
        if (!alive) return;
        try {
          const evt = JSON.parse(e.data);
          const listeners = listenersRef.current.get(evt.type);
          if (listeners) {
            for (const fn of listeners) fn(evt.payload);
          }
        } catch {
          // ignore parse errors
        }
      };
    }

    void connect();

    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
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

  return { connected, on };
}
