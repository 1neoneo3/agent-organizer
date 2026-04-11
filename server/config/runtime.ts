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

export const SETTINGS_DEFAULTS = {
  review_mode: "pr_only" as const, // "none" | "pr_only" | "meeting"
  review_count: 1,
  qa_mode: "enabled" as const, // "enabled" | "disabled"
  qa_count: 2,
  self_review_threshold: "small" as const, // task size for auto self-review: "small" | "medium" | "all" | "none"
  auto_review: "true" as const, // "true" | "false" — auto-trigger review agent on pr_review
  auto_qa: "true" as const, // "true" | "false" — auto-trigger QA agent on qa_testing
  auto_dispatch_mode: "all_inbox" as const, // "disabled" | "github_only" | "all_inbox"
};


export const AUTO_ASSIGN_TASK_ON_CREATE = process.env.AUTO_ASSIGN_TASK_ON_CREATE !== "false";
export const AUTO_RUN_TASK_ON_CREATE = process.env.AUTO_RUN_TASK_ON_CREATE !== "false";
