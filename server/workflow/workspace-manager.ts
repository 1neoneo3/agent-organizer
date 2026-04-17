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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function buildBranchName(task: Task, prefix: string): string {
  const base = task.task_number ? task.task_number.replace(/^#/, "t") : sanitizeSegment(task.id);
  const title = sanitizeSegment(task.title);
  return `${sanitizeSegment(prefix)}/${sanitizeSegment(base)}-${title}`.replace(/\/-/, "/");
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

  if (!existsSync(worktreePath)) {
    const currentRef = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
    try {
      runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, currentRef]);
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      if (stderr.includes("already exists")) {
        runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);
      } else {
        throw error;
      }
    }
  }

  return {
    cwd: worktreePath,
    branchName,
    rootPath: repoRoot,
  };
}
