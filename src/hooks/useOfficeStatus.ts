/**
 * useOfficeStatus – Derives office layout state from agents, tasks, and
 * real-time WebSocket events.
 *
 * Categorises agents into two zones:
 *   • deskAgents  — currently "working" (seated at desk with active task)
 *   • lobbyAgents — "idle" or "offline" (waiting area / absent)
 *
 * Tracks *transitions* so the UI can play entrance/exit animations when an
 * agent moves between zones (e.g. task started → slide to desk).
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Agent, Task, WSEventType } from "../types/index.js";

// ---- Transition tracking ----

export type TransitionKind =
  | "enter_desk"    // agent just sat down (task started)
  | "leave_desk"    // agent just stood up  (task completed / went idle)
  | "go_offline"    // agent disappeared
  | "come_online";  // agent came back online

export interface AgentTransition {
  agentId: string;
  kind: TransitionKind;
  /** epoch ms when the transition was detected */
  at: number;
}

/** How long a transition stays "active" before being pruned (ms). */
const TRANSITION_TTL_MS = 1200;

// ---- Public hook interface ----

export interface OfficeStatus {
  /** Agents currently at a desk (status === "working"). */
  deskAgents: Array<{ agent: Agent; task: Task | null }>;
  /** Agents in the lobby (idle / offline). */
  lobbyAgents: Agent[];
  /** Recent transitions — cleared automatically after TRANSITION_TTL_MS. */
  transitions: AgentTransition[];
}

type WsOn = (type: WSEventType, fn: (payload: unknown) => void) => () => void;

export function useOfficeStatus(
  agents: Agent[],
  tasks: Task[],
  on: WsOn,
): OfficeStatus {
  // Keep a snapshot of previous agent statuses to detect transitions.
  const prevStatusRef = useRef<Map<string, Agent["status"]>>(new Map());
  const [transitions, setTransitions] = useState<AgentTransition[]>([]);

  // ---- Derive desk / lobby partitions (pure computation) ----

  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  const deskAgents = useMemo(
    () =>
      agents
        .filter((a) => a.status === "working")
        .map((agent) => ({
          agent,
          task: agent.current_task_id ? (taskById.get(agent.current_task_id) ?? null) : null,
        })),
    [agents, taskById],
  );

  const lobbyAgents = useMemo(
    () => agents.filter((a) => a.status !== "working"),
    [agents],
  );

  // ---- Detect transitions when agents array changes ----

  const detectTransitions = useCallback(
    (nextAgents: Agent[]) => {
      const prev = prevStatusRef.current;
      const now = Date.now();
      const newTransitions: AgentTransition[] = [];

      for (const agent of nextAgents) {
        const oldStatus = prev.get(agent.id);
        if (oldStatus === undefined || oldStatus === agent.status) continue;

        const newStatus: string = agent.status;
        const prevStatus: string = oldStatus;

        if (newStatus === "working" && prevStatus !== "working") {
          newTransitions.push({ agentId: agent.id, kind: "enter_desk", at: now });
        } else if (newStatus === "idle" && prevStatus === "working") {
          newTransitions.push({ agentId: agent.id, kind: "leave_desk", at: now });
        } else if (newStatus === "offline") {
          newTransitions.push({ agentId: agent.id, kind: "go_offline", at: now });
        } else if (prevStatus === "offline" && newStatus !== "offline") {
          newTransitions.push({ agentId: agent.id, kind: "come_online", at: now });
        }
      }

      if (newTransitions.length > 0) {
        setTransitions((t) => [...t, ...newTransitions]);
      }

      // Update snapshot
      const next = new Map<string, Agent["status"]>();
      for (const a of nextAgents) next.set(a.id, a.status);
      prevStatusRef.current = next;
    },
    [],
  );

  // Initialise snapshot on first render (no transitions emitted).
  useEffect(() => {
    if (prevStatusRef.current.size === 0 && agents.length > 0) {
      const map = new Map<string, Agent["status"]>();
      for (const a of agents) map.set(a.id, a.status);
      prevStatusRef.current = map;
    }
  }, [agents]);

  // Detect transitions whenever agents change.
  useEffect(() => {
    if (prevStatusRef.current.size > 0) {
      detectTransitions(agents);
    }
  }, [agents, detectTransitions]);

  // ---- Subscribe to WebSocket for eager transition detection ----

  useEffect(() => {
    // agent_status events already update the agents array via useAppData,
    // but we subscribe here to catch the raw event and fire transitions ASAP.
    const unsub = on("agent_status", (payload) => {
      const update = payload as Partial<Agent> & { id: string };
      if (!update.status) return;

      const prev = prevStatusRef.current;
      const oldStatus = prev.get(update.id);
      if (oldStatus === undefined || oldStatus === update.status) return;

      const now = Date.now();
      let kind: TransitionKind | null = null;

      const newStatus: string = update.status;
      const prevStatus: string = oldStatus;

      if (newStatus === "working" && prevStatus !== "working") {
        kind = "enter_desk";
      } else if (newStatus === "idle" && prevStatus === "working") {
        kind = "leave_desk";
      } else if (newStatus === "offline") {
        kind = "go_offline";
      } else if (prevStatus === "offline" && newStatus !== "offline") {
        kind = "come_online";
      }

      if (kind) {
        setTransitions((t) => [...t, { agentId: update.id, kind, at: now }]);
      }
      prev.set(update.id, update.status);
    });

    return unsub;
  }, [on]);

  // ---- Auto-prune stale transitions ----

  useEffect(() => {
    if (transitions.length === 0) return;

    const timer = setTimeout(() => {
      const cutoff = Date.now() - TRANSITION_TTL_MS;
      setTransitions((t) => t.filter((tr) => tr.at > cutoff));
    }, TRANSITION_TTL_MS);

    return () => clearTimeout(timer);
  }, [transitions]);

  return { deskAgents, lobbyAgents, transitions };
}
