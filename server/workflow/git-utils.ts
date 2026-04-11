import { spawnSync } from "node:child_process";

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

/**
 * Read the `remote.origin.url` config for a project path, normalize it,
 * and return the HTTPS form. Returns `null` when the path is not a git
 * repository, there is no `origin` remote, or the remote URL is an
 * unrecognized shape.
 *
 * Uses `spawnSync` with an argv array (not a shell string) so callers do
 * not have to sanitize `projectPath` — unusual characters cannot be
 * interpreted as shell metacharacters.
 */
export function detectRepositoryUrl(projectPath: string): string | null {
  if (!projectPath) return null;
  try {
    const result = spawnSync(
      "git",
      ["-C", projectPath, "remote", "get-url", "origin"],
      { timeout: 2000, encoding: "utf8" },
    );
    if (result.status !== 0) return null;
    return normalizeGitUrl(result.stdout);
  } catch {
    return null;
  }
}
