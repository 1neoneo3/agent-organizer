import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../types/runtime.js";
import { loadProjectWorkflow, type ProjectWorkflow } from "./loader.js";
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

export interface RemoveTaskWorkspaceOptions {
  /**
   * When true, also delete the per-task git branch. Default: true.
   * Set to false to keep the branch around (e.g. so a follow-up rerun can
   * cherry-pick from it). The branch is only force-deleted; if it still
   * holds unpushed commits not on the remote, deletion will silently
   * fail and the branch is preserved.
   */
  deleteBranch?: boolean;
}

export interface RemoveTaskWorkspaceResult {
  removed: boolean;
  branchDeleted: boolean;
  reason?: string;
}

/**
 * Remove the per-task `.ao-worktrees/<task.id>` directory and (optionally)
 * delete the corresponding branch. Designed to be called when a task
 * reaches a terminal status (done / cancelled) so completed worktrees do
 * not pile up and create branch-name conflicts on auto-dispatch.
 *
 * Safe to call when the worktree does not exist or the project is not a
 * git repo — both return `{ removed: false }` with a reason and never
 * throw. Callers should treat this as best-effort cleanup.
 *
 * Branch deletion uses `git branch -d` (safe delete), which refuses to
 * drop branches holding commits not reachable from HEAD. After worktree
 * removal the repo HEAD is on main, so a task branch whose commits
 * landed on main (typical for `done` after PR merge) deletes cleanly,
 * while a branch with local-only commits survives — preserving any
 * unpushed work-in-progress that a `cancelled` transition might
 * otherwise discard silently.
 */
export function removeTaskWorkspace(
  task: Task,
  workflow: ProjectWorkflow | null,
  options: RemoveTaskWorkspaceOptions = {},
): RemoveTaskWorkspaceResult {
  const { deleteBranch = true } = options;
  const projectPath = task.project_path ?? process.cwd();

  let repoRoot: string;
  try {
    repoRoot = runGit(projectPath, ["rev-parse", "--show-toplevel"]);
  } catch {
    return { removed: false, branchDeleted: false, reason: "not-a-git-repo" };
  }

  const worktreePath = join(repoRoot, ".ao-worktrees", task.id);
  if (!existsSync(worktreePath)) {
    return { removed: false, branchDeleted: false, reason: "worktree-not-found" };
  }

  // --force discards any uncommitted state in the worktree. The agent
  // process owning it must already be terminated by the time a task
  // reaches done/cancelled, so there is nothing to preserve.
  try {
    runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { removed: false, branchDeleted: false, reason: `worktree-remove-failed: ${message}` };
  }

  if (!deleteBranch) {
    return { removed: true, branchDeleted: false };
  }

  const branchPrefix = workflow?.branchPrefix ?? "ao";
  const branchName = buildBranchName(task, branchPrefix);
  let branchDeleted = false;
  try {
    runGit(repoRoot, ["branch", "-d", branchName]);
    branchDeleted = true;
  } catch {
    // Branch may already be gone, or it may hold commits not yet on
    // main. Either way the worktree itself was removed; the branch
    // survives so the user can recover unpushed work.
  }

  return { removed: true, branchDeleted };
}

/**
 * Convenience wrapper for sites that have a `Task` but not yet loaded a
 * `ProjectWorkflow`. Resolves the workflow from `task.project_path` and
 * delegates to `removeTaskWorkspace`. Returns `{ removed: false }` with
 * a reason for tasks that have no `project_path` (the workspace mode
 * cannot be inferred without one).
 */
export function tryCleanupCompletedTaskWorkspace(
  task: Task,
  options: RemoveTaskWorkspaceOptions = {},
): RemoveTaskWorkspaceResult {
  if (!task.project_path) {
    return { removed: false, branchDeleted: false, reason: "no-project-path" };
  }
  const workflow = loadProjectWorkflow(task.project_path);
  return removeTaskWorkspace(task, workflow, options);
}

/**
 * Disposition for one worktree during reconcile.
 *
 * - `removed`: worktree (and optionally branch) was deleted
 * - `kept`: task is still active in DB, worktree left intact
 * - `preserved`: would have been removed but was protected (e.g.
 *   the branch holds commits not yet on main, or git refused the
 *   worktree-remove call)
 * - `error`: unexpected failure during inspection or removal
 */
export interface ReconcileWorktreeEntry {
  taskId: string;
  branchName: string | null;
  worktreePath: string;
}

export interface ReconcileWorktreesResult {
  scanned: number;
  removed: Array<ReconcileWorktreeEntry & { reason: "orphan" | "done" | "cancelled" }>;
  kept: Array<ReconcileWorktreeEntry & { status: string }>;
  preserved: Array<ReconcileWorktreeEntry & { reason: "unpushed-commits" | "remove-failed"; details?: string }>;
  errors: Array<ReconcileWorktreeEntry & { error: string }>;
}

export interface ReconcileWorktreesOptions {
  /**
   * Repository root to inspect. Defaults to `process.cwd()` so the
   * server boot sequence can call this with no args. Tests override.
   */
  cwd?: string;
  /**
   * Whether to also remove worktrees for tasks in `cancelled` status.
   * Default false: cancelled tasks can be revived via /tasks/:id/resume,
   * so removing the worktree would lose the rework starting point.
   */
  removeCancelled?: boolean;
}

interface RawWorktreeEntry {
  path: string;
  branchRef: string | null;
}

function listGitWorktrees(repoRoot: string): RawWorktreeEntry[] {
  let output: string;
  try {
    output = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const entries: RawWorktreeEntry[] = [];
  let current: { path?: string; branchRef?: string | null } = {};
  const flush = () => {
    if (current.path) {
      entries.push({ path: current.path, branchRef: current.branchRef ?? null });
    }
    current = {};
  };
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      current.branchRef = line.slice("branch ".length);
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return entries;
}

const AO_WORKTREE_TASK_ID_RE = /\.ao-worktrees\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

function extractAoTaskId(worktreePath: string): string | null {
  const match = worktreePath.match(AO_WORKTREE_TASK_ID_RE);
  return match ? match[1] : null;
}

/**
 * Check whether a branch holds commits that are not reachable from main.
 * Conservative: any failure to compare returns `true` so we err on the
 * side of preserving potentially-valuable work.
 */
function branchHasUnpushedCommits(repoRoot: string, branchName: string): boolean {
  try {
    const base = resolveOriginMainBase(repoRoot);
    const count = runGit(repoRoot, ["rev-list", "--count", `${base}..${branchName}`]);
    return parseInt(count, 10) > 0;
  } catch {
    return true;
  }
}

interface ReconcileTaskRow {
  id: string;
  status: string;
}

/**
 * Sweep `.ao-worktrees/` for stale entries on server boot. Removes
 * worktrees whose corresponding task either no longer exists in the DB
 * (orphans, e.g. from a wiped or reset DB) or has reached `done`.
 * Worktrees for active tasks (refinement / in_progress / pr_review /
 * human_review / qa_testing / test_generation / inbox) are kept so
 * resuming or post-merge cleanup proceeds normally.
 *
 * Branches with commits not yet on main are preserved (worktree
 * directory removed but branch intact) so that unpushed work is
 * recoverable. By default `cancelled` is also kept because /tasks/:id
 * /resume can revive it; pass `removeCancelled: true` to override.
 *
 * Idempotent and side-effect-bounded: failures on individual worktrees
 * do not abort the sweep, and the function never throws.
 */
export function reconcileAoWorktrees(
  db: DatabaseSync,
  options: ReconcileWorktreesOptions = {},
): ReconcileWorktreesResult {
  const cwd = options.cwd ?? process.cwd();
  const result: ReconcileWorktreesResult = {
    scanned: 0,
    removed: [],
    kept: [],
    preserved: [],
    errors: [],
  };

  let repoRoot: string;
  try {
    repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return result;
  }

  const taskLookup = db.prepare("SELECT id, status FROM tasks WHERE id = ?");

  for (const wt of listGitWorktrees(repoRoot)) {
    const taskId = extractAoTaskId(wt.path);
    if (!taskId) continue;
    result.scanned += 1;

    const branchName = wt.branchRef ? wt.branchRef.replace(/^refs\/heads\//, "") : null;
    const entry: ReconcileWorktreeEntry = {
      taskId,
      branchName,
      worktreePath: wt.path,
    };

    const row = taskLookup.get(taskId) as ReconcileTaskRow | undefined;

    let removeReason: "orphan" | "done" | "cancelled" | null = null;
    if (!row) removeReason = "orphan";
    else if (row.status === "done") removeReason = "done";
    else if (row.status === "cancelled" && options.removeCancelled) removeReason = "cancelled";

    if (!removeReason) {
      result.kept.push({ ...entry, status: row?.status ?? "unknown" });
      continue;
    }

    if (branchName && branchHasUnpushedCommits(repoRoot, branchName)) {
      result.preserved.push({ ...entry, reason: "unpushed-commits" });
      continue;
    }

    try {
      runGit(repoRoot, ["worktree", "remove", "--force", wt.path]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.preserved.push({ ...entry, reason: "remove-failed", details: message });
      continue;
    }

    if (branchName) {
      try {
        runGit(repoRoot, ["branch", "-d", branchName]);
      } catch {
        // Branch survives. The worktree was already removed which is
        // the goal — branch lifecycle is best-effort here.
      }
    }

    result.removed.push({ ...entry, reason: removeReason });
  }

  // Drop any stale `.git/worktrees/<id>` admin entries pointing to paths
  // we just removed (or that were already missing). `git worktree prune`
  // is idempotent and quick.
  try {
    runGit(repoRoot, ["worktree", "prune"]);
  } catch {
    // non-fatal
  }

  return result;
}

/**
 * Run `reconcileAoWorktrees` once per distinct `project_path` recorded
 * in the tasks table. AO worktrees live inside each project's own repo
 * (`<project_path>/.ao-worktrees/<task.id>`), so a single sweep against
 * one cwd would miss worktrees in any project other than the one the
 * AO server itself runs from. Tasks without `project_path` are skipped
 * — those tasks were never paired with a git repo.
 *
 * Aggregates the per-project results into one summary. Per-project
 * failures are isolated: a non-git project_path or a missing directory
 * yields an empty result for that project but does not abort the
 * overall sweep.
 */
export function reconcileAllAoWorktrees(
  db: DatabaseSync,
  options: Omit<ReconcileWorktreesOptions, "cwd"> = {},
): ReconcileWorktreesResult & { projects: number } {
  const projectPaths = (
    db.prepare("SELECT DISTINCT project_path FROM tasks WHERE project_path IS NOT NULL")
      .all() as Array<{ project_path: string }>
  )
    .map((row) => row.project_path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  const aggregate: ReconcileWorktreesResult & { projects: number } = {
    scanned: 0,
    removed: [],
    kept: [],
    preserved: [],
    errors: [],
    projects: 0,
  };

  for (const cwd of projectPaths) {
    const sub = reconcileAoWorktrees(db, { ...options, cwd });
    if (sub.scanned === 0) continue;
    aggregate.projects += 1;
    aggregate.scanned += sub.scanned;
    aggregate.removed.push(...sub.removed);
    aggregate.kept.push(...sub.kept);
    aggregate.preserved.push(...sub.preserved);
    aggregate.errors.push(...sub.errors);
  }

  return aggregate;
}
