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
 * Outcome of a stage-specific agent selection. The four states let
 * callers distinguish "the user did not configure this stage" from
 * "the user configured it but no matching worker is reachable", which
 * the legacy boolean/`undefined` return type collapsed into the same
 * silent fallback.
 *
 *  - `unconfigured`: both role + model filters are empty/whitespace. The
 *    caller should run its existing default selection logic.
 *  - `configured_match`: at least one idle matching worker exists in the
 *    candidate pool (or in the DB when no pool is provided).
 *  - `configured_no_match`: filters are set, but no row in the
 *    `agents` table currently satisfies them (worker + idle + role/model
 *    + not in `excludeIds`). The caller MUST NOT fall back to a default
 *    agent; instead it should skip dispatch and retry next tick.
 *  - `configured_no_match_in_pool`: filters are set and matching idle
 *    workers exist in the DB, but none of them are in `candidatePool`
 *    (typically because earlier dispatches in the same tick already
 *    consumed them). The caller should skip this dispatch round so the
 *    matching worker is reused on the next tick rather than the task
 *    silently being assigned to a non-matching worker.
 */
export type StageAgentSelectionResult =
  | { status: "unconfigured" }
  | { status: "configured_match"; agent: Agent }
  | { status: "configured_no_match" }
  | { status: "configured_no_match_in_pool"; matchingIds: string[] };

export interface StageAgentSelectionOptions {
  /**
   * Agent ids to exclude from selection (e.g. the implementer of the
   * task being reviewed, so the same agent never reviews their own
   * work). Null/undefined/empty entries are tolerated.
   */
  excludeIds?: ReadonlyArray<string | null | undefined>;
  /**
   * Optional pool restricting which agents are eligible *for this
   * particular tick*. The auto-dispatcher passes the set of idle
   * worker ids it has not yet consumed in the current tick so a
   * matching worker that was already given to an earlier task is
   * surfaced as `configured_no_match_in_pool` rather than silently
   * being replaced by a non-matching agent.
   */
  candidatePool?: ReadonlySet<string>;
}

/**
 * Stage-specific agent selection driven by the `*_agent_role` /
 * `*_agent_model` settings. Returns a structured result so callers can
 * choose to (a) honour the configured override, (b) skip dispatch when
 * configured but no match is reachable, or (c) fall back to their own
 * default selector when no filter is configured.
 *
 * Selection rules when configured:
 *  - only `agent_type = 'worker'` rows are considered,
 *  - only `status = 'idle'` rows are considered,
 *  - both `role` and `cli_model` filters apply when set (ANDed),
 *  - rows in `excludeIds` are removed,
 *  - when `candidatePool` is provided, the chosen agent must also be
 *    in that pool.
 *
 * The chosen agent within an eligible set is picked uniformly at
 * random so the override does not consistently starve one matching
 * worker.
 */
export function resolveStageAgentSelection(
  db: DatabaseSync,
  roleSettingKey: StageSettingKey,
  modelSettingKey: StageModelSettingKey,
  options: StageAgentSelectionOptions = {},
): StageAgentSelectionResult {
  const excluded = new Set(
    (options.excludeIds ?? []).filter((id): id is string => !!id),
  );

  const roleRow = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(roleSettingKey) as { value: string } | undefined;
  const modelRow = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(modelSettingKey) as { value: string } | undefined;

  const role = roleRow?.value?.trim() || "";
  const model = modelRow?.value?.trim() || "";
  if (!role && !model) return { status: "unconfigured" };

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

  if (candidates.length === 0) {
    return { status: "configured_no_match" };
  }

  if (options.candidatePool) {
    const pool = options.candidatePool;
    const inPool = candidates.filter((c) => pool.has(c.id));
    if (inPool.length === 0) {
      return {
        status: "configured_no_match_in_pool",
        matchingIds: candidates.map((c) => c.id),
      };
    }
    const pickedIndex = Math.floor(Math.random() * inPool.length);
    return { status: "configured_match", agent: inPool[pickedIndex] };
  }

  const pickedIndex = Math.floor(Math.random() * candidates.length);
  return { status: "configured_match", agent: candidates[pickedIndex] };
}

/**
 * Backward-compatible wrapper around {@link resolveStageAgentSelection}
 * that collapses the structured result back to `Agent | undefined`.
 *
 * Prefer {@link resolveStageAgentSelection} in new code so the caller
 * can distinguish "no match" from "no filter" and emit the right log /
 * skip behaviour. This wrapper is kept so existing callers that only
 * needed the happy path continue to compile without behaviour change.
 */
export function resolveStageAgentOverride(
  db: DatabaseSync,
  roleSettingKey: StageSettingKey,
  modelSettingKey: StageModelSettingKey,
  excludeIds: Array<string | null | undefined> = [],
): Agent | undefined {
  const result = resolveStageAgentSelection(db, roleSettingKey, modelSettingKey, {
    excludeIds,
  });
  return result.status === "configured_match" ? result.agent : undefined;
}
