import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

export type RepositoryIdentityFailureCode =
  | "workspace_not_git_repository"
  | "workspace_project_path_not_toplevel"
  | "workspace_repository_mismatch";

export interface RepositoryIdentity {
  taskId: string;
  projectPath: string;
  resolvedProjectPath: string | null;
  gitToplevel: string | null;
  resolvedGitToplevel: string | null;
  actualRepositoryUrl: string | null;
  expectedRepositoryUrl: string | null;
  expectedRepositoryUrls: string[];
}

export class RepositoryIdentityError extends Error {
  readonly code: RepositoryIdentityFailureCode;
  readonly identity: RepositoryIdentity;

  constructor(code: RepositoryIdentityFailureCode, identity: RepositoryIdentity, reason: string) {
    super(formatRepositoryIdentityError(reason, identity));
    this.name = "RepositoryIdentityError";
    this.code = code;
    this.identity = identity;
  }
}

/**
 * Normalize a raw git remote URL to a canonical HTTPS form suitable for
 * display and clicking.
 *
 * Supported inputs (all with or without a trailing `.git`):
 *   - SSH shorthand: `git@github.com:user/repo` → `https://github.com/user/repo`
 *   - SSH scheme:    `ssh://git@github.com/user/repo` → `https://github.com/user/repo`
 *   - git+ssh:       `git+ssh://git@github.com/user/repo` → `https://github.com/user/repo`
 *   - HTTPS:         `https://github.com/user/repo.git` → `https://github.com/user/repo`
 *   - HTTP:          `http://host/path` → `http://host/path` (preserved)
 *
 * Returns `null` for empty input or unrecognized shapes so callers can
 * decide whether to store the raw value or skip it entirely.
 */
export function normalizeGitUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip trailing .git once we finalize the URL form. Do the strip at the
  // end so we can match shapes without worrying about the suffix.

  // SSH shorthand: `git@host:user/repo` (no scheme, colon separates host/path)
  const sshMatch = trimmed.match(/^git@([^:/]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  // Scheme-qualified SSH: `ssh://...` or `git+ssh://...` or `git://...`
  const schemeMatch = trimmed.match(/^(?:git\+)?(?:ssh|git):\/\/(?:([^@/]+)@)?([^/]+)\/(.+)$/);
  if (schemeMatch) {
    const host = schemeMatch[2];
    const path = schemeMatch[3].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  // HTTPS / HTTP — keep as-is, strip trailing .git
  if (/^https?:\/\//.test(trimmed)) {
    return trimmed.replace(/\.git$/, "");
  }

  return null;
}

export type ExpectedRepositoryInput = string | string[] | null | undefined;

function normalizeComparableGitUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = normalizeGitUrl(raw) ?? raw.trim();
  const comparable = normalized.replace(/\/+$/, "").replace(/\.git$/, "");
  return comparable || null;
}

export function parseExpectedRepositoryUrls(
  repositoryUrls: string | null | undefined,
  repositoryUrl: string | null | undefined,
): string[] {
  const fromArray: string[] = [];
  if (repositoryUrls?.trim()) {
    try {
      const parsed = JSON.parse(repositoryUrls) as unknown;
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          if (typeof value !== "string") continue;
          const normalized = normalizeComparableGitUrl(value);
          if (normalized) fromArray.push(normalized);
        }
      }
    } catch {
      // Invalid legacy JSON falls back to the single repository_url field.
    }
  }
  const preferred = fromArray.length > 0
    ? fromArray
    : [normalizeComparableGitUrl(repositoryUrl)].filter((v): v is string => Boolean(v));
  return Array.from(new Set(preferred));
}

function normalizeExpectedRepositoryInput(input: ExpectedRepositoryInput): string[] {
  const rawValues = Array.isArray(input) ? input : [input];
  const normalized = rawValues
    .map((value) => typeof value === "string" ? normalizeComparableGitUrl(value) : null)
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(normalized));
}

export function redactGitUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = "";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/(https?:\/\/)[^/@\s]+@/i, "$1redacted@");
  }
}

function runGit(projectPath: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", projectPath, ...args], {
    timeout: 2000,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const stdout = result.stdout.trim();
  return stdout || null;
}

function formatRepositoryIdentityError(reason: string, identity: RepositoryIdentity): string {
  return [
    reason,
    `task_id=${identity.taskId}`,
    `project_path=${identity.projectPath}`,
    `git_toplevel=${identity.gitToplevel ?? "null"}`,
    `actual_repository_url=${redactGitUrl(identity.actualRepositoryUrl) ?? "null"}`,
    `expected_repository_url=${identity.expectedRepositoryUrls.map((url) => redactGitUrl(url)).join(",") || "null"}`,
  ].join("; ");
}

export function inspectRepositoryIdentity(
  taskId: string,
  projectPath: string,
  expectedRepositoryUrl?: ExpectedRepositoryInput,
): RepositoryIdentity {
  const expectedRepositoryUrls = normalizeExpectedRepositoryInput(expectedRepositoryUrl);
  let resolvedProjectPath: string | null = null;
  try {
    resolvedProjectPath = realpathSync(projectPath);
  } catch {
    return {
      taskId,
      projectPath,
      resolvedProjectPath: null,
      gitToplevel: null,
      resolvedGitToplevel: null,
      actualRepositoryUrl: null,
      expectedRepositoryUrl: expectedRepositoryUrls[0] ?? null,
      expectedRepositoryUrls,
    };
  }

  const gitToplevel = runGit(resolvedProjectPath, ["rev-parse", "--show-toplevel"]);
  let resolvedGitToplevel: string | null = null;
  if (gitToplevel) {
    try {
      resolvedGitToplevel = realpathSync(gitToplevel);
    } catch {
      resolvedGitToplevel = null;
    }
  }

  const rawRemote = gitToplevel
    ? runGit(resolvedProjectPath, ["remote", "get-url", "origin"])
    : null;
  const actualRepositoryUrl = normalizeComparableGitUrl(rawRemote);
  const expected = expectedRepositoryUrls.length > 0
    ? expectedRepositoryUrls
    : actualRepositoryUrl ? [actualRepositoryUrl] : [];

  return {
    taskId,
    projectPath,
    resolvedProjectPath,
    gitToplevel,
    resolvedGitToplevel,
    actualRepositoryUrl,
    expectedRepositoryUrl: expected[0] ?? null,
    expectedRepositoryUrls: expected,
  };
}

export function assertRepositoryIdentity(
  taskId: string,
  projectPath: string,
  expectedRepositoryUrl?: ExpectedRepositoryInput,
): RepositoryIdentity {
  const identity = inspectRepositoryIdentity(taskId, projectPath, expectedRepositoryUrl);

  if (!identity.resolvedProjectPath || !identity.gitToplevel || !identity.resolvedGitToplevel) {
    throw new RepositoryIdentityError(
      "workspace_not_git_repository",
      identity,
      "project_path is not a git repository",
    );
  }

  if (identity.resolvedProjectPath !== identity.resolvedGitToplevel) {
    throw new RepositoryIdentityError(
      "workspace_project_path_not_toplevel",
      identity,
      "project_path must be the git toplevel",
    );
  }

  if (!identity.actualRepositoryUrl || identity.expectedRepositoryUrls.length === 0) {
    throw new RepositoryIdentityError(
      "workspace_not_git_repository",
      identity,
      "repository_url could not be auto-detected from origin",
    );
  }

  if (!identity.expectedRepositoryUrls.includes(identity.actualRepositoryUrl)) {
    throw new RepositoryIdentityError(
      "workspace_repository_mismatch",
      identity,
      "repository_url does not match project_path origin",
    );
  }

  return identity;
}

/**
 * Read the `remote.origin.url` config for a project path, normalize it,
 * and return the HTTPS form. Returns `null` when:
 *   - the path is empty or unreadable
 *   - the path is not a git repository (or git itself fails)
 *   - there is no `origin` remote
 *   - the remote URL is an unrecognized shape
 *   - the path is NOT the git worktree toplevel (see below)
 *
 * The toplevel check is important. `git -C <path>` walks parent
 * directories to find a `.git` dir, so a subdirectory of an unrelated
 * parent repository would otherwise inherit that parent's origin. We
 * have seen this misfire when `project_path` is `/home/mk/workspace`
 * while `/home/mk/.git` points at an unrelated `system-protection-
 * scripts` repo — the walk finds that repo even though no project code
 * lives there. Rejecting non-toplevel paths is the safest default; a
 * future caller that *wants* mono-repo subdirectory detection can opt
 * in explicitly.
 *
 * Uses `spawnSync` with an argv array (not a shell string) so callers do
 * not have to sanitize `projectPath` — unusual characters cannot be
 * interpreted as shell metacharacters.
 */
export function detectRepositoryUrl(projectPath: string): string | null {
  if (!projectPath) return null;
  try {
    // Resolve symlinks to compare against git's output reliably. If
    // realpath fails (path missing), bail out — no origin to report.
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(projectPath);
    } catch {
      return null;
    }

    const toplevelResult = spawnSync(
      "git",
      ["-C", resolvedPath, "rev-parse", "--show-toplevel"],
      { timeout: 2000, encoding: "utf8" },
    );
    if (toplevelResult.status !== 0) return null;
    const toplevel = toplevelResult.stdout.trim();
    if (!toplevel) return null;

    // Only return a URL when the project path IS the git toplevel. A
    // descendant of some unrelated parent git repo must not inherit that
    // parent's origin.
    let resolvedToplevel: string;
    try {
      resolvedToplevel = realpathSync(toplevel);
    } catch {
      return null;
    }
    if (resolvedToplevel !== resolvedPath) return null;

    const originResult = spawnSync(
      "git",
      ["-C", resolvedPath, "remote", "get-url", "origin"],
      { timeout: 2000, encoding: "utf8" },
    );
    if (originResult.status !== 0) return null;
    return normalizeGitUrl(originResult.stdout);
  } catch {
    return null;
  }
}
