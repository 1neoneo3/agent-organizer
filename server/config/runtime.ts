import { randomBytes } from "node:crypto";

export const PORT = Number(process.env.PORT ?? 8791);
export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const IS_DEV = NODE_ENV === "development";

export const SESSION_AUTH_TOKEN =
  process.env.SESSION_AUTH_TOKEN && process.env.SESSION_AUTH_TOKEN !== "change-me-to-random-secret"
    ? process.env.SESSION_AUTH_TOKEN
    : randomBytes(32).toString("hex");

export const DB_PATH = process.env.DB_PATH ?? "data/agent-organizer.db";

export const TASK_RUN_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
export const TASK_RUN_HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

export const WS_BATCH_INTERVALS: Record<string, number> = {
  cli_output: 250,
  subtask_update: 150,
};
export const WS_MAX_BATCH_QUEUE = 60;

export const REVIEW_SETTINGS_DEFAULTS = {
  review_mode: "pr_only" as const, // "none" | "pr_only" | "meeting"
  review_count: 1,
  self_review_threshold: "small" as const, // task size for auto self-review: "small" | "medium" | "all" | "none"
};
