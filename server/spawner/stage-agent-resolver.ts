import type { DatabaseSync } from "node:sqlite";
import type { Agent } from "../types/runtime.js";

export type StageSettingKey =
  | "refinement_agent_id"
  | "review_agent_id"
  | "qa_agent_id"
  | "test_generation_agent_id";

/**
 * Resolve a stage-specific default agent override from the settings
 * table. Returns the agent only when:
 *  - the `{stage}_agent_id` setting is a non-empty string,
 *  - the referenced agent exists, is a worker, and is idle,
 *  - the agent id is not in `excludeIds` (typically the implementer).
 *
 * Returns `undefined` in every other case so callers can fall back to
 * their existing role-based selection logic without change of behavior.
 */
export function resolveStageAgentOverride(
  db: DatabaseSync,
  settingKey: StageSettingKey,
  excludeIds: Array<string | null | undefined> = [],
): Agent | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(settingKey) as { value: string } | undefined;
  const agentId = row?.value?.trim();
  if (!agentId) return undefined;

  const excluded = new Set(excludeIds.filter((id): id is string => !!id));
  if (excluded.has(agentId)) return undefined;

  const agent = db
    .prepare(
      "SELECT * FROM agents WHERE id = ? AND agent_type = 'worker' AND status = 'idle' LIMIT 1",
    )
    .get(agentId) as Agent | undefined;
  return agent;
}
