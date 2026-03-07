import { execFileSync } from "node:child_process";
import type { Task } from "../types/runtime.js";
import type { ProjectWorkflow } from "./loader.js";
import type { TaskWorkspace } from "./workspace-manager.js";

export type ReviewSyncStatus =
  | "pending"
  | "not_applicable"
  | "local_commit_ready"
  | "pushed"
  | "pr_open";

export interface ReviewArtifactPromotionResult {
  branchName: string | null;
  commitSha: string | null;
  prUrl: string | null;
  syncStatus: ReviewSyncStatus;
  syncError: string | null;
  baseBranch: string | null;
}

interface CommandExecutor {
  (command: string, args: string[], options: {
    cwd: string;
    encoding: BufferEncoding;
    stdio: ["ignore", "pipe", "pipe"];
  }): string;
}

interface PromoteOptions {
  exec?: CommandExecutor;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  exec: CommandExecutor,
): string {
  return exec(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commandErrorToMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr = "stderr" in error && typeof error.stderr === "string"
    ? error.stderr.trim()
    : "";
  const stdout = "stdout" in error && typeof error.stdout === "string"
    ? error.stdout.trim()
    : "";

  return stderr || stdout || error.message;
}

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "task";
}

function buildCommitMessage(task: Task): string {
  const suffix = task.task_number
    ? task.task_number.replace(/^#/, "task-")
    : sanitizeSegment(task.id);
  return `feat: finalize ${suffix}`;
}

function buildPrTitle(task: Task): string {
  return `feat: ${task.task_number ?? "タスク"} のレビュー成果物を固定`;
}

function buildPrBody(task: Task, branchName: string, commitSha: string): string {
  const lines = [
    "## 概要",
    "- task worktree の成果物を正式な review artifact として固定",
    `- 対象タスク: ${task.title}`,
    `- review branch: ${branchName}`,
    `- review commit: ${commitSha}`,
    "",
    "## テスト",
    "- Agent Organizer による自動昇格フローで生成",
  ];
  return lines.join("\n");
}

function detectBaseBranch(cwd: string, exec: CommandExecutor): string {
  try {
    const ref = runCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], cwd, exec);
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // fall through
  }

  return "main";
}

function lookupExistingPrUrl(cwd: string, branchName: string, exec: CommandExecutor): string | null {
  const raw = runCommand("gh", ["pr", "list", "--head", branchName, "--json", "url", "--limit", "1"], cwd, exec);
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as Array<{ url?: string }>;
  return parsed[0]?.url ?? null;
}

export function promoteTaskReviewArtifact(
  task: Task,
  workflow: ProjectWorkflow | null,
  workspace: TaskWorkspace,
  options?: PromoteOptions,
): ReviewArtifactPromotionResult {
  const exec = options?.exec ?? execFileSync;
  const result: ReviewArtifactPromotionResult = {
    branchName: workspace.branchName,
    commitSha: null,
    prUrl: task.pr_url,
    syncStatus: "pending",
    syncError: null,
    baseBranch: null,
  };

  if (!workflow || workflow.workspaceMode !== "git-worktree" || !workspace.branchName) {
    return {
      ...result,
      syncStatus: "not_applicable",
    };
  }

  try {
    const branchName = runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], workspace.cwd, exec);
    result.branchName = branchName;

    const dirty = runCommand("git", ["status", "--short"], workspace.cwd, exec);
    if (dirty) {
      runCommand("git", ["add", "-A"], workspace.cwd, exec);
      runCommand("git", ["commit", "-m", buildCommitMessage(task)], workspace.cwd, exec);
    }

    result.commitSha = runCommand("git", ["rev-parse", "HEAD"], workspace.cwd, exec);
    result.syncStatus = "local_commit_ready";
  } catch (error) {
    result.syncError = `commit failed: ${commandErrorToMessage(error)}`;
    return result;
  }

  try {
    runCommand("git", ["push", "-u", "origin", result.branchName!], workspace.cwd, exec);
    result.syncStatus = "pushed";
  } catch (error) {
    result.syncError = `push failed: ${commandErrorToMessage(error)}`;
    return result;
  }

  try {
    result.baseBranch = detectBaseBranch(workspace.cwd, exec);
    result.prUrl = lookupExistingPrUrl(workspace.cwd, result.branchName!, exec)
      ?? runCommand(
        "gh",
        [
          "pr",
          "create",
          "--base",
          result.baseBranch,
          "--head",
          result.branchName!,
          "--title",
          buildPrTitle(task),
          "--body",
          buildPrBody(task, result.branchName!, result.commitSha!),
        ],
        workspace.cwd,
        exec,
      );
    result.syncStatus = result.prUrl ? "pr_open" : "pushed";
  } catch (error) {
    result.syncError = `pr failed: ${commandErrorToMessage(error)}`;
  }

  return result;
}
