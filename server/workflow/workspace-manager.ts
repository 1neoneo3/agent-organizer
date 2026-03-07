import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../types/runtime.js";
import type { ProjectWorkflow } from "./loader.js";

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

export function prepareTaskWorkspace(
  task: Task,
  workflow: ProjectWorkflow | null,
): TaskWorkspace {
  const projectPath = task.project_path ?? process.cwd();
  if (!workflow || workflow.workspaceMode !== "git-worktree") {
    return {
      cwd: projectPath,
      branchName: null,
      rootPath: projectPath,
    };
  }

  const repoRoot = runGit(projectPath, ["rev-parse", "--show-toplevel"]);
  const branchName = buildBranchName(task, workflow.branchPrefix);
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
