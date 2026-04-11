import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

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
