import type { DatabaseSync } from "node:sqlite";
import type { Agent } from "../types/runtime.js";

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

export function pickIdleImplementerAgent(
  db: DatabaseSync,
  excludeIds: Array<string | null | undefined> = [],
): Agent | undefined {
  const filteredIds = excludeIds.filter((id): id is string => !!id);
  const where = [
    "status = 'idle'",
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
