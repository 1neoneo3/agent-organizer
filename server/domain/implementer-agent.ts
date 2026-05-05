import type { DatabaseSync } from "node:sqlite";
import type { Agent } from "../types/runtime.js";
import { getTaskSetting } from "./task-settings.js";

export const NON_IMPLEMENTER_ROLES = new Set([
  "code_reviewer",
  "security_reviewer",
  "tester",
]);

export function isNonImplementerRole(role: string | null | undefined): boolean {
  return !!role && NON_IMPLEMENTER_ROLES.has(role);
}

export function isImplementerAgent(
  agent: Pick<Agent, "agent_type" | "role"> | null | undefined,
): boolean {
  if (!agent) return false;
  if (agent.agent_type !== "worker") return false;
  return !isNonImplementerRole(agent.role);
}

export function isRunnableImplementerAgent(
  agent: Agent | null | undefined,
): agent is Agent {
  return !!agent && isImplementerAgent(agent) && agent.status === "idle" && agent.current_task_id === null;
}

export function resolveConfiguredInProgressAgent(
  db: DatabaseSync,
  taskId?: string | null,
  excludeIds: Array<string | null | undefined> = [],
): Agent | undefined {
  const configuredId = getTaskSetting(db, "in_progress_agent_id", taskId)?.trim() ?? "";
  if (!configuredId) return undefined;

  const excluded = new Set(excludeIds.filter((id): id is string => !!id));
  if (excluded.has(configuredId)) return undefined;

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(configuredId) as Agent | undefined;
  if (!isRunnableImplementerAgent(agent)) return undefined;
  return agent;
}

export type ImplementerResolutionResult =
  | { ok: true; agent: Agent; source: "requested" | "configured" | "assigned" | "fallback" }
  | { ok: false; error: "no_implementer_available" | "agent_not_found" | "agent_busy" | "non_implementer_agent" };

export interface ImplementerResolutionOptions {
  taskId?: string | null;
  excludeIds?: Array<string | null | undefined>;
}

export function resolveImplementerAgentForExecution(
  db: DatabaseSync,
  taskAssignedAgentId: string | null | undefined,
  requestedAgentId: string | null | undefined,
  options: ImplementerResolutionOptions = {},
): ImplementerResolutionResult {
  const excluded = new Set((options.excludeIds ?? []).filter((id): id is string => !!id));

  if (requestedAgentId) {
    const requestedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(requestedAgentId) as Agent | undefined;
    if (!requestedAgent) {
      return { ok: false, error: "agent_not_found" };
    }
    if (!isImplementerAgent(requestedAgent)) {
      return { ok: false, error: "non_implementer_agent" };
    }
    if (!isRunnableImplementerAgent(requestedAgent)) {
      return { ok: false, error: "agent_busy" };
    }
    return { ok: true, agent: requestedAgent, source: "requested" };
  }

  const configuredAgent = resolveConfiguredInProgressAgent(db, options.taskId, [...excluded]);
  if (configuredAgent) {
    return { ok: true, agent: configuredAgent, source: "configured" };
  }

  if (taskAssignedAgentId && !excluded.has(taskAssignedAgentId)) {
    const assignedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(taskAssignedAgentId) as Agent | undefined;
    if (isRunnableImplementerAgent(assignedAgent)) {
      return { ok: true, agent: assignedAgent, source: "assigned" };
    }
  }

  const fallbackAgent = pickIdleImplementerAgent(db, [taskAssignedAgentId, ...excluded]);
  if (!fallbackAgent) {
    return { ok: false, error: "no_implementer_available" };
  }
  return { ok: true, agent: fallbackAgent, source: "fallback" };
}

export function pickIdleImplementerAgent(
  db: DatabaseSync,
  excludeIds: Array<string | null | undefined> = [],
): Agent | undefined {
  const filteredIds = excludeIds.filter((id): id is string => !!id);
  const where = [
    "status = 'idle'",
    "current_task_id IS NULL",
    "agent_type = 'worker'",
    "(role IS NULL OR role NOT IN ('code_reviewer', 'security_reviewer', 'tester'))",
  ];
  const args: string[] = [];

  if (filteredIds.length > 0) {
    where.push(`id NOT IN (${filteredIds.map(() => "?").join(",")})`);
    args.push(...filteredIds);
  }

  return db.prepare(
    `SELECT * FROM agents
     WHERE ${where.join(" AND ")}
     ORDER BY
       CASE
         WHEN role = 'lead_engineer' THEN 0
         WHEN role IS NULL OR role = '' THEN 1
         ELSE 2
       END,
       stats_tasks_done ASC,
       updated_at ASC
     LIMIT 1`,
  ).get(...args) as Agent | undefined;
}
