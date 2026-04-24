import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../types/runtime.js";
import type { ProjectWorkflow } from "./loader.js";
import { SETTINGS_DEFAULTS, isWorkspaceMode, type WorkspaceMode } from "../config/runtime.js";

export interface TaskWorkspace {
  cwd: string;
  branchName: string | null;
  rootPath: string;
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return sanitized || "task";
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

interface StoredStash {
  commit: string;
  message: string;
}

function isAoWorktreeRootIgnored(cwd: string): boolean {
  try {
    runGit(cwd, ["check-ignore", "--quiet", ".ao-worktrees"]);
    return true;
  } catch {
    return false;
  }
}

function worktreeRootPathspec(cwd: string): string[] {
  return isAoWorktreeRootIgnored(cwd) ? [] : ["--", ":(exclude).ao-worktrees"];
}

function hasGitChanges(cwd: string): boolean {
  return runGit(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    ...worktreeRootPathspec(cwd),
  ]).length > 0;
}

function currentBranch(cwd: string): string | null {
  try {
    return runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null;
  } catch {
    return null;
  }
}

function findStoredStash(cwd: string, message: string): StoredStash | null {
  const list = runGit(cwd, ["stash", "list", "--format=%H%x00%s"]);
  for (const line of list.split("\n")) {
    if (!line.trim()) continue;
    const [commit, subject] = line.split("\0");
    if (commit && (subject === message || subject.endsWith(`: ${message}`))) {
      return { commit, message };
    }
  }
  return null;
}

function findStashRefByCommit(cwd: string, commit: string): string | null {
  const list = runGit(cwd, ["stash", "list", "--format=%H%x00%gd"]);
  for (const line of list.split("\n")) {
    if (!line.trim()) continue;
    const [stashCommit, ref] = line.split("\0");
    if (stashCommit === commit && ref) return ref;
  }
  return null;
}

function stashChanges(cwd: string, message: string): StoredStash | null {
  if (!hasGitChanges(cwd)) return null;
  runGit(cwd, [
    "stash",
    "push",
    "--include-untracked",
    "-m",
    message,
    ...worktreeRootPathspec(cwd),
  ]);
  const stash = findStoredStash(cwd, message);
  if (!stash) {
    throw new Error(`Created git stash but could not resolve it by message: ${message}`);
  }
  return stash;
}

function applyAndDropStash(cwd: string, stash: StoredStash): void {
  runGit(cwd, ["stash", "apply", "--index", stash.commit]);
  const ref = findStashRefByCommit(cwd, stash.commit);
  if (ref) runGit(cwd, ["stash", "drop", ref]);
}

function branchExists(cwd: string, branchName: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

function checkoutMainLocally(repoRoot: string): void {
  if (currentBranch(repoRoot) === "main") return;

  if (branchExists(repoRoot, "main")) {
    runGit(repoRoot, ["checkout", "main"]);
    return;
  }

  try {
    runGit(repoRoot, ["rev-parse", "--verify", "origin/main"]);
    runGit(repoRoot, ["checkout", "-B", "main", "origin/main"]);
  } catch {
    // Repositories without a local or remote main branch are valid in tests and
    // private repos. In that case, leave the source checkout as-is.
  }
}

/**
 * Resolve the base ref for a new worktree. Enforces "latest origin/main"
 * when an `origin` remote exists so worktrees never start from a stale
 * local ref. Falls back to local `main` for repos without an origin remote.
 */
function resolveOriginMainBase(repoRoot: string): string {
  let hasOrigin = false;
  try {
    const remotes = runGit(repoRoot, ["remote"]);
    hasOrigin = remotes.split(/\s+/).some((r) => r === "origin");
  } catch {
    hasOrigin = false;
  }

  if (hasOrigin) {
    try {
      runGit(repoRoot, ["fetch", "origin", "main", "--quiet"]);
      runGit(repoRoot, ["rev-parse", "--verify", "origin/main"]);
      return "origin/main";
    } catch {
      // origin has no `main` branch — fall through to local fallback.
    }
  }

  if (branchExists(repoRoot, "main")) return "main";

  return runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
}

function buildBranchName(task: Task, prefix: string): string {
  const conventionalPrefix = resolveConventionalBranchPrefix(task, prefix);
  const base = task.task_number ? task.task_number.replace(/^#/, "t") : sanitizeSegment(task.id);
  const title = sanitizeSegment(task.title);
  return `${conventionalPrefix}/${sanitizeSegment(base)}-${title}`.replace(/\/-/, "/");
}

const CONVENTIONAL_BRANCH_PREFIXES = new Set([
  "feat",
  "fix",
  "refactor",
  "docs",
  "chore",
  "test",
  "ci",
  "perf",
]);

function resolveConventionalBranchPrefix(task: Task, configuredPrefix: string): string {
  const sanitizedConfigured = sanitizeSegment(configuredPrefix);
  if (CONVENTIONAL_BRANCH_PREFIXES.has(sanitizedConfigured)) {
    return sanitizedConfigured;
  }

  const text = `${task.title}\n${task.description ?? ""}`.toLowerCase();
  if (/\b(doc|docs|readme|markdown|mdx?)\b|ドキュメント|資料/.test(text)) {
    return "docs";
  }
  if (/\b(refactor|cleanup|clean-up|simplify|restructure)\b|リファクタ|整理/.test(text)) {
    return "refactor";
  }
  if (/\b(fix|bug|bugfix|error|crash|fail|failure|regression|broken)\b|不具合|バグ|修正|失敗|エラー/.test(text)) {
    return "fix";
  }
  if (/\b(test|tests|testing|spec|e2e|playwright|vitest|jest)\b|テスト/.test(text)) {
    return "test";
  }
  if (/\b(ci|github actions?)\b|\b(actions? workflow|workflow (file|ya?ml))\b/.test(text)) {
    return "ci";
  }
  if (/\b(perf|performance|speed|optimi[sz]e)\b|高速化|性能/.test(text)) {
    return "perf";
  }
  if (/\b(chore|config|settings|deps|dependency|dependencies|tooling|build|lint|format)\b|設定|依存|更新/.test(text)) {
    return "chore";
  }

  return "feat";
}

function ensureWorktreeOnBranch(worktreePath: string, branchName: string, taskId: string): void {
  if (!existsSync(worktreePath)) return;

  const existingBranch = currentBranch(worktreePath);
  if (existingBranch === branchName) return;

  const worktreeStash = stashChanges(
    worktreePath,
    `AO worktree handoff: ${taskId} before checkout ${branchName}`,
  );
  if (branchExists(worktreePath, branchName)) {
    runGit(worktreePath, ["checkout", branchName]);
  } else {
    const checkoutArgs = existingBranch
      ? ["checkout", "-B", branchName, existingBranch]
      : ["checkout", "-B", branchName];
    runGit(worktreePath, checkoutArgs);
  }
  if (worktreeStash) {
    applyAndDropStash(worktreePath, worktreeStash);
  }
}

/**
 * Read the global `default_workspace_mode` setting. Returns `undefined`
 * when the setting is missing, empty, or unrecognized; callers should
 * then fall back to `SETTINGS_DEFAULTS.default_workspace_mode`.
 */
function readGlobalWorkspaceMode(db: DatabaseSync | undefined): WorkspaceMode | undefined {
  if (!db) return undefined;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'default_workspace_mode'")
      .get() as { value: string } | undefined;
    const raw = row?.value?.trim();
    if (raw && isWorkspaceMode(raw)) return raw;
  } catch {
    // Settings table may not exist in tests that construct minimal DBs.
  }
  return undefined;
}

/**
 * Resolve the effective workspace mode for a task.
 *
 * Precedence (first match wins):
 *   1. Explicit `workspace_mode` in the project's WORKFLOW.md
 *   2. Global `default_workspace_mode` setting
 *   3. `SETTINGS_DEFAULTS.default_workspace_mode` — only reached when
 *      the db is unavailable (e.g. minimal test fixtures) or the row
 *      was manually deleted. Keeps the schema and the code in sync
 *      without a separate magic string.
 */
export function resolveWorkspaceMode(
  workflow: ProjectWorkflow | null,
  db?: DatabaseSync,
): WorkspaceMode {
  const explicit = workflow?.workspaceMode ?? null;
  if (explicit) return explicit;
  const fromSettings = readGlobalWorkspaceMode(db);
  if (fromSettings) return fromSettings;
  return SETTINGS_DEFAULTS.default_workspace_mode;
}

export function prepareTaskWorkspace(
  task: Task,
  workflow: ProjectWorkflow | null,
  db?: DatabaseSync,
): TaskWorkspace {
  const projectPath = task.project_path ?? process.cwd();
  const effectiveMode = resolveWorkspaceMode(workflow, db);
  if (effectiveMode !== "git-worktree") {
    return {
      cwd: projectPath,
      branchName: null,
      rootPath: projectPath,
    };
  }

  const repoRoot = runGit(projectPath, ["rev-parse", "--show-toplevel"]);
  const branchPrefix = workflow?.branchPrefix ?? "ao";
  const branchName = buildBranchName(task, branchPrefix);
  const worktreeRoot = join(repoRoot, ".ao-worktrees");
  const worktreePath = join(worktreeRoot, task.id);

  mkdirSync(worktreeRoot, { recursive: true });

  if (currentBranch(repoRoot) === branchName) {
    checkoutMainLocally(repoRoot);
  }

  if (!existsSync(worktreePath)) {
    const baseRef = resolveOriginMainBase(repoRoot);
    try {
      runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseRef]);
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      if (stderr.includes("already exists")) {
        runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);
      } else {
        throw error;
      }
    }
  } else {
    ensureWorktreeOnBranch(worktreePath, branchName, task.id);
  }

  return {
    cwd: worktreePath,
    branchName,
    rootPath: repoRoot,
  };
}
