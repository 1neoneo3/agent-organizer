import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_ENV_PATH = resolve(PROJECT_ROOT, ".env");

export function loadProjectEnv(envPath = DEFAULT_ENV_PATH): void {
  if (typeof process.loadEnvFile !== "function") {
    return;
  }

  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

loadProjectEnv();

export const PORT = Number(process.env.PORT ?? 8791);
export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const IS_DEV = NODE_ENV === "development";

function resolveAuthToken(): string {
  if (process.env.SESSION_AUTH_TOKEN && process.env.SESSION_AUTH_TOKEN !== "change-me-to-random-secret") {
    return process.env.SESSION_AUTH_TOKEN;
  }

  // Persist token to data/.session-token so it survives restarts
  const tokenPath = resolve(__dirname, "..", "..", "data", ".session-token");
  try {
    const stored = readFileSync(tokenPath, "utf8").trim();
    if (stored.length >= 32) return stored;
  } catch {
    // File doesn't exist yet
  }

  const token = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch {
    // Fall back to ephemeral token if write fails
  }
  return token;
}

export const SESSION_AUTH_TOKEN = resolveAuthToken();

export const DB_PATH = process.env.DB_PATH ?? "data/agent-organizer.db";

export const TASK_RUN_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
export const TASK_RUN_HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

export const WS_BATCH_INTERVALS: Record<string, number> = {
  subtask_update: 150,
  // cli_output is the busiest event on the bus: every stdout chunk from
  // every running agent produces one broadcast. Under parallel load this
  // floods the main thread with JSON.stringify + ws.send calls and
  // starves DB writes. Batching at 80ms is below the human perception
  // threshold for "live log" feel but cuts the call rate roughly 10x
  // when 10 agents are streaming simultaneously.
  cli_output: 80,
};
export const WS_MAX_BATCH_QUEUE = 60;

export const DEFAULT_CLI_MODELS: Record<string, string> = {
  claude: "claude-opus-4-6",
  codex: "gpt-5.4",
  gemini: "gemini-2.5-pro",
};

export const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
export const REDIS_ENABLED = process.env.REDIS_ENABLED !== "false";
export const CACHE_KEY_PREFIX = "ao:";
export const GITHUB_SYNC_ENABLED = process.env.GITHUB_SYNC_ENABLED === "true";

function resolveGithubSyncRepo(): string {
  if (process.env.GITHUB_SYNC_REPO?.trim()) {
    return process.env.GITHUB_SYNC_REPO.trim();
  }

  try {
    const remoteUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

function resolveGithubSyncToken(): string {
  if (process.env.GITHUB_SYNC_TOKEN?.trim()) {
    return process.env.GITHUB_SYNC_TOKEN.trim();
  }

  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export const GITHUB_SYNC_REPO = resolveGithubSyncRepo();
export const GITHUB_SYNC_TOKEN = resolveGithubSyncToken();
export const GITHUB_SYNC_INTERVAL_MS = Number(process.env.GITHUB_SYNC_INTERVAL_MS ?? 300_000);
export const GITHUB_SYNC_PROJECT_PATH = process.env.GITHUB_SYNC_PROJECT_PATH ?? PROJECT_ROOT;
export const AUTO_DISPATCH_INTERVAL_MS = Number(process.env.AUTO_DISPATCH_INTERVAL_MS ?? 60_000);

// Maximum number of times orphan recovery may automatically re-spawn a parked
// in_progress task. The counter resets on any forward stage transition
// (in_progress → qa_testing, pr_review → in_progress rework, etc.), on
// manual Run (POST /tasks/:id/run), and on manual feedback-rework.
export const ORPHAN_AUTO_RESPAWN_MAX = Number(process.env.ORPHAN_AUTO_RESPAWN_MAX ?? 3);

export const SETTINGS_DEFAULTS = {
  review_mode: "pr_only" as const, // "none" | "pr_only" | "meeting"
  review_count: 1,
  qa_mode: "enabled" as const, // "enabled" | "disabled"
  qa_count: 2,
  self_review_threshold: "small" as const, // task size for auto self-review: "small" | "medium" | "all" | "none"
  auto_review: "true" as const, // "true" | "false" — auto-trigger review agent on pr_review
  auto_qa: "true" as const, // "true" | "false" — auto-trigger QA agent on qa_testing
  auto_dispatch_mode: "all_inbox" as const, // "disabled" | "github_only" | "all_inbox"
  // Phase 1: run tsc / lint / tests / e2e in parallel at pr_review entry.
  // Enabled by default so new installations benefit immediately; the
  // module is a no-op unless at least one `check_*_cmd` is configured
  // (per-project via WORKFLOW.md or globally via settings), so turning
  // this on is safe on empty projects.
  auto_checks_enabled: "true" as const, // "true" | "false"
  // Enable the test_generation stage globally so every task that does
  // not explicitly opt out in WORKFLOW.md gets a dedicated tester pass
  // after implementation. Small tasks still skip this stage by design.
  default_enable_test_generation: "true" as const, // "true" | "false"
  default_enable_refinement: "false" as const, // "true" | "false" — run planning agent before implementation
  refinement_auto_approve: "false" as const, // "true" | "false" — skip human approval of refinement plan
  // Output language for agent-generated artifacts (task titles, task
  // descriptions, refinement plans, review/QA narrative text, and PR
  // titles/bodies). "ja" preserves the historical Japanese output;
  // "en" switches the natural-language portions of every agent prompt
  // and PR body template to English. Control tokens / marker tags
  // (SPRINT CONTRACT, [REVIEW:<role>:PASS], ---REFINEMENT PLAN---,
  // ---END REFINEMENT--- etc.) remain stable across languages so that
  // downstream parsers keep working.
  output_language: "ja" as const, // "ja" | "en"
  // Stage-specific default agent overrides. Empty string means "no
  // override" — the existing role-based resolver is used. When set, the
  // value is an agent id; the auto-* spawn paths prefer that agent when
  // it is idle and not the task's implementer. `assigned_agent_id` on
  // the task continues to represent the implementer (in_progress) and
  // is unaffected by these settings. human_review has no auto-spawn
  // path today, so no setting is exposed for it.
  refinement_agent_id: "" as const,
  review_agent_id: "" as const,
  qa_agent_id: "" as const,
  test_generation_agent_id: "" as const,
  ci_check_agent_id: "" as const,
};

export const VALID_OUTPUT_LANGUAGES = ["ja", "en"] as const;
export type OutputLanguage = (typeof VALID_OUTPUT_LANGUAGES)[number];

export function isOutputLanguage(value: string): value is OutputLanguage {
  return (VALID_OUTPUT_LANGUAGES as readonly string[]).includes(value);
}


export const AUTO_ASSIGN_TASK_ON_CREATE = process.env.AUTO_ASSIGN_TASK_ON_CREATE !== "false";
export const AUTO_RUN_TASK_ON_CREATE = process.env.AUTO_RUN_TASK_ON_CREATE !== "false";
