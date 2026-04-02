import { join } from "node:path";
import { homedir } from "node:os";
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from "../workflow/loader.js";

const ANSI_ESCAPE_REGEX =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const CLI_SPINNER_LINE_REGEX = /^[\s.·•◦○●◌◍◐◓◑◒◉◎|/\\\-⠁-⣿]+$/u;

export function withCliPathFallback(currentPath: string): string {
  const home = homedir();
  const extras = [
    join(home, ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    join(home, ".nvm", "versions", "node"),
  ];
  const parts = currentPath.split(":");
  for (const extra of extras) {
    if (!parts.includes(extra)) parts.push(extra);
  }
  // Ensure ~/bin is first so cgroup wrapper scripts take priority
  const homeBin = join(home, "bin");
  const filtered = parts.filter((p) => p !== homeBin);
  return [homeBin, ...filtered].join(":");
}

/** Default allowed tools for implementation tasks */
const DEFAULT_ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob", "Agent",
];

/** Restricted tools for explore/read-only phases */
export const EXPLORE_ALLOWED_TOOLS = [
  "Read", "Bash", "Grep", "Glob", "Agent",
];

/** Tools for review phases */
export const REVIEW_ALLOWED_TOOLS = [
  "Read", "Bash", "Grep", "Glob",
];

export function buildAgentArgs(
  provider: string,
  opts?: {
    model?: string;
    reasoningLevel?: string;
    noTools?: boolean;
    resumeSessionId?: string;
    codexSandboxMode?: CodexSandboxMode;
    codexApprovalPolicy?: CodexApprovalPolicy;
    allowedTools?: string[];
  }
): string[] {
  const {
    model,
    reasoningLevel,
    noTools,
    resumeSessionId,
    codexSandboxMode = "workspace-write",
    codexApprovalPolicy = "on-request",
    allowedTools,
  } = opts ?? {};

  switch (provider) {
    case "claude": {
      const args = [
        "claude",
        "--dangerously-skip-permissions",
        "--print",
        "--verbose",
        "--output-format=stream-json",
        "--max-turns",
        "200",
      ];
      if (resumeSessionId) args.push("--resume", resumeSessionId);
      if (model) args.push("--model", model);
      if (allowedTools && allowedTools.length > 0) {
        args.push("--allowedTools", allowedTools.join(","));
      }
      return args;
    }
    case "codex": {
      const args = ["codex"];
      if (model) args.push("-m", model);
      args.push("exec", "--json");
      if (
        codexSandboxMode === "workspace-write" &&
        codexApprovalPolicy === "on-request"
      ) {
        args.push("--full-auto");
      } else {
        args.push("--sandbox", codexSandboxMode);
      }
      return args;
    }
    case "gemini": {
      const args = ["gemini"];
      if (model) args.push("-m", model);
      args.push("--yolo", "--output-format=stream-json");
      return args;
    }
    default:
      throw new Error(`Unknown CLI provider: ${provider}`);
  }
}

export function normalizeStreamChunk(raw: Buffer | string): string {
  const input = typeof raw === "string" ? raw : raw.toString("utf8");
  return input
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^reading prompt from stdin\.{0,3}$/i.test(trimmed)) return false;
      if (CLI_SPINNER_LINE_REGEX.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function hasStructuredJsonLines(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try {
      JSON.parse(line);
      return true;
    } catch {
      // not JSON
    }
  }
  return false;
}
