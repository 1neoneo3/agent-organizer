import type { DatabaseSync } from "node:sqlite";
import type { Agent } from "../types/runtime.js";

export type StageSettingKey =
  | "refinement_agent_role"
  | "review_agent_role"
  | "qa_agent_role"
  | "test_generation_agent_role";

export type StageModelSettingKey =
  | "refinement_agent_model"
  | "review_agent_model"
  | "qa_agent_model"
  | "test_generation_agent_model";

/**
 * Resolve a stage-specific default agent override from the settings
 * table. Returns a randomly chosen idle worker only when:
 *  - the stage role/model filters are non-empty,
 *  - at least one idle worker matches those filters,
 *  - the chosen agent id is not in `excludeIds` (typically the implementer).
 *
 * Returns `undefined` in every other case so callers can fall back to
 * their existing role-based selection logic without change of behavior.
 */
export function resolveStageAgentOverride(
  db: DatabaseSync,
  roleSettingKey: StageSettingKey,
  modelSettingKey: StageModelSettingKey,
  excludeIds: Array<string | null | undefined> = [],
): Agent | undefined {
  const excluded = new Set(excludeIds.filter((id): id is string => !!id));

  const roleRow = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(roleSettingKey) as { value: string } | undefined;
  const modelRow = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(modelSettingKey) as { value: string } | undefined;

  const role = roleRow?.value?.trim() || "";
  const model = modelRow?.value?.trim() || "";
  if (!role && !model) return undefined;

  const where: string[] = ["agent_type = 'worker'", "status = 'idle'"];
  const args: string[] = [];

  if (role) {
    where.push("role = ?");
    args.push(role);
  }
  if (model) {
    where.push("cli_model = ?");
    args.push(model);
  }
  if (excluded.size > 0) {
    const placeholders = [...excluded].map(() => "?").join(",");
    where.push(`id NOT IN (${placeholders})`);
    args.push(...excluded);
  }

  const candidates = db
    .prepare(`SELECT * FROM agents WHERE ${where.join(" AND ")}`)
    .all(...args) as unknown as Agent[];

  if (candidates.length === 0) return undefined;
  const pickedIndex = Math.floor(Math.random() * candidates.length);
  return candidates[pickedIndex];
}
