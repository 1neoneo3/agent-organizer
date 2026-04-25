import { useState, useEffect, useCallback, useRef } from "react";
import { fetchAgent, fetchAgents, fetchTask, fetchTasks, fetchSettings, fetchCliStatus, fetchDirective, fetchDirectives, fetchInteractivePrompts } from "../api/endpoints.js";
import { useWebSocket } from "./useWebSocket.js";
import type { Agent, TaskSummary, Directive, Settings, CliStatus, InteractivePrompt } from "../types/index.js";
import { mergeAgentUpdate, mergeDirectiveUpdate, mergeTaskUpdate } from "./state-updates.js";

export function useAppData() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [cliStatus, setCliStatus] = useState<CliStatus>({});
  const [interactivePrompts, setInteractivePrompts] = useState<Map<string, InteractivePrompt>>(new Map());
  const [loading, setLoading] = useState(true);
  const { connected, on, subscribeTask } = useWebSocket();
  const hasInitialized = useRef(false);

  const reload = useCallback(async () => {
    try {
      const [a, t, d, s, c, ip] = await Promise.all([
        fetchAgents(),
        fetchTasks(),
        fetchDirectives(),
        fetchSettings(),
        fetchCliStatus(),
        fetchInteractivePrompts(),
      ]);
      setAgents(a);
      setTasks(t);
      setDirectives(d);
      setSettings(s);
      setCliStatus(c);
      // Hydrate interactive prompts from server on load/reload
      const promptMap = new Map<string, InteractivePrompt>();
      for (const p of ip) {
        promptMap.set(p.task_id, p);
      }
      setInteractivePrompts(promptMap);
    } catch (err) {
      console.error("Failed to load data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Re-fetch all data when WebSocket reconnects (recovers missed events including interactive prompts)
  useEffect(() => {
    if (connected && hasInitialized.current) {
      void reload();
    }
    if (connected) {
      hasInitialized.current = true;
    }
  }, [connected, reload]);

  // WebSocket updates
  useEffect(() => {
    const unsubs = [
      on("task_update", (payload) => {
        const update = payload as Partial<TaskSummary> & { id: string };
        setTasks((prev) => {
          const result = mergeTaskUpdate(prev, update);
          if (!result.found) {
            void fetchTasks()
              .then((fresh) => setTasks(fresh))
              .catch(() => void reload());
          }
          return result.next;
        });
      }),
      on("agent_status", (payload) => {
        const update = payload as Partial<Agent> & { id: string };
        setAgents((prev) => {
          const result = mergeAgentUpdate(prev, update);
          if (!result.found) {
            void fetchAgent(update.id)
              .then((agent) => {
                setAgents((current) => current.some((entry) => entry.id === agent.id) ? current : [agent, ...current]);
              })
              .catch(() => void reload());
          }
          return result.next;
        });
      }),
      on("directive_update", (payload) => {
        const update = payload as Partial<Directive> & { id: string };
        setDirectives((prev) => {
          const result = mergeDirectiveUpdate(prev, update);
          if (!result.found) {
            void fetchDirective(update.id)
              .then((directive) => {
                setDirectives((current) => current.some((entry) => entry.id === directive.id) ? current : [directive, ...current]);
              })
              .catch(() => void reload());
          }
          return result.next;
        });
      }),
      on("interactive_prompt", (payload) => {
        const prompt = payload as InteractivePrompt;
        setInteractivePrompts((prev) => {
          const next = new Map(prev);
          next.set(prompt.task_id, prompt);
          return next;
        });
      }),
      on("interactive_prompt_resolved", (payload) => {
        const { task_id } = payload as { task_id: string };
        setInteractivePrompts((prev) => {
          const next = new Map(prev);
          next.delete(task_id);
          return next;
        });
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [on, reload]);

  return { agents, tasks, directives, settings, cliStatus, interactivePrompts, loading, connected, reload, on, subscribeTask };
}
