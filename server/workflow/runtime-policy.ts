import type { Agent } from "../types/runtime.js";
import { detectRepositoryUrl, normalizeGitUrl } from "./git-utils.js";
import type { ProjectWorkflow } from "./loader.js";

export type GitHubWriteMode = "enabled" | "disabled";

export interface GitHubWriteControls {
  mode: GitHubWriteMode;
  allowedRepos: string | null;
  tokenPassthrough: boolean;
  projectPath: string | null;
}

export interface AgentRuntimePolicy {
  provider: Agent["cli_provider"];
  codexSandboxMode: ProjectWorkflow["codexSandboxMode"] | null;
  codexApprovalPolicy: ProjectWorkflow["codexApprovalPolicy"] | null;
  githubWriteMode?: GitHubWriteMode;
  githubWriteAllowedRepos?: string[];
  githubWriteTokenPassthrough?: boolean;
  githubWriteAllowed?: boolean;
  githubWriteReason?: string;
  projectRepositoryUrl?: string | null;
  localhostAllowed: boolean;
  canAgentRunE2E: boolean;
  e2eExecution: ProjectWorkflow["e2eExecution"];
  e2eCommand: string | null;
  summary: string;
}

function parseAllowedRepos(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }

  const normalized = raw.trim();
  if (!normalized) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
  } catch {
    // fall back to line/comma separated input
  }

  return normalized
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function extractRepoSlug(repositoryUrl: string | null): string | null {
  if (!repositoryUrl) {
    return null;
  }

  const match = repositoryUrl.match(
    /^https?:\/\/[^/]+\/([^/]+\/[^/]+)$/i,
  );
  return match?.[1].toLowerCase() ?? null;
}

function normalizeAllowedRepo(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }

  const normalizedUrl = normalizeGitUrl(trimmed);
  if (normalizedUrl) {
    return normalizedUrl.toLowerCase();
  }

  return trimmed.toLowerCase();
}

function resolveGitHubWriteAccess(
  controls: GitHubWriteControls | undefined,
): {
  mode: GitHubWriteMode;
  allowedRepos: string[];
  tokenPassthrough: boolean;
  repositoryUrl: string | null;
  allowed: boolean;
  reason: string;
} {
  const mode = controls?.mode ?? "disabled";
  const allowedRepos = parseAllowedRepos(controls?.allowedRepos);
  const normalizedAllowedRepos = allowedRepos
    .map(normalizeAllowedRepo)
    .filter((entry): entry is string => entry !== null);
  const repositoryUrl = controls?.projectPath
    ? detectRepositoryUrl(controls.projectPath)
    : null;
  const repositorySlug = extractRepoSlug(repositoryUrl);

  if (mode !== "enabled") {
    return {
      mode,
      allowedRepos: normalizedAllowedRepos,
      tokenPassthrough: controls?.tokenPassthrough ?? false,
      repositoryUrl,
      allowed: false,
      reason: "disabled by settings or WORKFLOW.md",
    };
  }

  if (!repositoryUrl && allowedRepos.length > 0) {
    return {
      mode,
      allowedRepos: normalizedAllowedRepos,
      tokenPassthrough: controls?.tokenPassthrough ?? false,
      repositoryUrl,
      allowed: false,
      reason: "repository URL could not be resolved",
    };
  }

  const normalizedRepoUrl = repositoryUrl?.toLowerCase() ?? null;
  const normalizedRepoSlug = repositorySlug;

  if (normalizedAllowedRepos.length > 0) {
    const matched = normalizedAllowedRepos.some((entry) => {
      if (entry === "*") return true;
      return (
        entry === normalizedRepoUrl ||
        entry === normalizedRepoSlug
      );
    });

    if (!matched) {
      return {
        mode,
        allowedRepos: normalizedAllowedRepos,
        tokenPassthrough: controls?.tokenPassthrough ?? false,
        repositoryUrl,
        allowed: false,
        reason: `repository ${repositoryUrl ?? normalizedRepoSlug ?? "unknown"} is not in the allow-list`,
      };
    }
  } else if (!repositoryUrl) {
    return {
      mode,
      allowedRepos: normalizedAllowedRepos,
      tokenPassthrough: controls?.tokenPassthrough ?? false,
      repositoryUrl,
      allowed: false,
      reason: "repository URL could not be resolved",
    };
  }

  return {
    mode,
    allowedRepos: normalizedAllowedRepos,
    tokenPassthrough: controls?.tokenPassthrough ?? false,
    repositoryUrl,
    allowed: true,
    reason: repositoryUrl
      ? `enabled for ${repositoryUrl}`
      : "enabled",
  };
}

export function resolveAgentRuntimePolicy(
  agent: Pick<Agent, "cli_provider">,
  workflow: ProjectWorkflow | null,
  controls?: GitHubWriteControls,
): AgentRuntimePolicy {
  const codexSandboxMode = workflow?.codexSandboxMode ?? "workspace-write";
  const codexApprovalPolicy = workflow?.codexApprovalPolicy ?? "on-request";
  const e2eExecution = workflow?.e2eExecution ?? "host";
  const e2eCommand = workflow?.e2eCommand ?? null;
  const githubWriteAccess = resolveGitHubWriteAccess(controls);
  const isCodex = agent.cli_provider === "codex";
  const localhostAllowed =
    !isCodex || codexSandboxMode === "danger-full-access";
  const canAgentRunE2E = e2eExecution === "agent" && localhostAllowed;

  const segments = [`Provider: ${agent.cli_provider}`];
  if (isCodex) {
    segments.push(`Codex sandbox: ${codexSandboxMode}`);
    segments.push(`Codex approval policy: ${codexApprovalPolicy}`);
  }
  segments.push(
    `GitHub write: ${githubWriteAccess.allowed ? "enabled" : "disabled"} (${githubWriteAccess.reason})`,
  );
  if (githubWriteAccess.allowed && githubWriteAccess.tokenPassthrough) {
    segments.push("GitHub credentials: inherited shell environment enabled");
  }
  segments.push(
    `Localhost listen: ${localhostAllowed ? "allowed" : "blocked by sandbox"}`,
  );

  if (canAgentRunE2E) {
    segments.push("Playwright E2E: agent may run locally");
  } else if (e2eExecution === "host") {
    segments.push("Playwright E2E: delegate to host execution");
  } else if (e2eExecution === "ci") {
    segments.push("Playwright E2E: delegate to CI");
  } else {
    segments.push(
      "Playwright E2E: agent execution requested but current runtime cannot listen on localhost",
    );
  }

  if (e2eCommand) {
    segments.push(`Suggested E2E command: ${e2eCommand}`);
  }

  return {
    provider: agent.cli_provider,
    codexSandboxMode: isCodex ? codexSandboxMode : null,
    codexApprovalPolicy: isCodex ? codexApprovalPolicy : null,
    githubWriteMode: githubWriteAccess.mode,
    githubWriteAllowedRepos: githubWriteAccess.allowedRepos,
    githubWriteTokenPassthrough: githubWriteAccess.tokenPassthrough,
    githubWriteAllowed: githubWriteAccess.allowed,
    githubWriteReason: githubWriteAccess.reason,
    projectRepositoryUrl: githubWriteAccess.repositoryUrl,
    localhostAllowed,
    canAgentRunE2E,
    e2eExecution,
    e2eCommand,
    summary: `${segments.join(". ")}.`,
  };
}
