import { useState, useEffect, useCallback } from "react";
import { fetchAgents, fetchTasks, fetchSettings, fetchCliStatus } from "../api/endpoints.js";
import { useWebSocket } from "./useWebSocket.js";
import type { Agent, Task, Settings, CliStatus } from "../types/index.js";

export function useAppData() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [cliStatus, setCliStatus] = useState<CliStatus>({});
  const [loading, setLoading] = useState(true);
  const { connected, on } = useWebSocket();

  const reload = useCallback(async () => {
    try {
      const [a, t, s, c] = await Promise.all([
        fetchAgents(),
        fetchTasks(),
        fetchSettings(),
        fetchCliStatus(),
      ]);
      setAgents(a);
      setTasks(t);
      setSettings(s);
      setCliStatus(c);
    } catch (err) {
      console.error("Failed to load data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // WebSocket updates
  useEffect(() => {
    const unsubs = [
      on("task_update", (payload) => {
        const update = payload as Partial<Task> & { id: string };
        setTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === update.id);
          if (idx === -1) {
            // New task or full reload needed
            void reload();
            return prev;
          }
          return prev.map((t) => (t.id === update.id ? { ...t, ...update } : t));
        });
      }),
      on("agent_status", (payload) => {
        const update = payload as Partial<Agent> & { id: string };
        setAgents((prev) => {
          const idx = prev.findIndex((a) => a.id === update.id);
          if (idx === -1) {
            void reload();
            return prev;
          }
          return prev.map((a) => (a.id === update.id ? { ...a, ...update } : a));
        });
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [on, reload]);

  return { agents, tasks, settings, cliStatus, loading, connected, reload };
}
