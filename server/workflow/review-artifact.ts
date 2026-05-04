import { execFileSync } from "node:child_process";
import type { Task } from "../types/runtime.js";
import type { ProjectWorkflow } from "./loader.js";
import type { TaskWorkspace } from "./workspace-manager.js";
import type { OutputLanguage } from "../config/runtime.js";
import {
  RepositoryIdentityError,
  assertRepositoryIdentity,
  parseExpectedRepositoryUrls,
} from "./git-utils.js";

const DEFAULT_LANGUAGE: OutputLanguage = "ja";

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
  executedCommands?: string[];
  /**
   * Output language for the PR body. Controls the section headers
   * (`## 背景` vs `## Background`, etc.) and the default verification
   * placeholder text. Defaults to Japanese to preserve historical
   * behavior.
   */
  language?: OutputLanguage;
  skipRepositoryGuard?: boolean;
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
  return `feat: ${task.title}`;
}

function buildPrTitle(task: Task): string {
  return `feat: ${task.title}`;
}

function buildPrBody(
  task: Task,
  branchName: string,
  commitSha: string,
  executedCommands: string[] = [],
  language: OutputLanguage = DEFAULT_LANGUAGE,
): string {
  const isEn = language === "en";
  const taskRef = task.task_number ? ` (${task.task_number})` : "";
  const description = (task.description ?? task.title).trim();

  // If description already contains markdown headings (## xxx), use it as-is
  // to avoid duplicating the Background section.
  const descriptionHasHeadings = /^##\s/m.test(description);

  const headings = isEn
    ? {
        background: "## Background",
        changes: "## Changes",
        scope: "## Scope",
        verification: "## Verification",
        other: "## Other",
      }
    : {
        background: "## 背景",
        changes: "## 行った変更",
        scope: "## 影響範囲",
        verification: "## 動作確認項目",
        other: "## その他",
      };

  const verificationLines = executedCommands.length > 0
    ? executedCommands.map((cmd) => `- [x] \`${cmd}\``)
    : ["- [ ] CI passed"];

  const backgroundSection = descriptionHasHeadings
    ? [`${description}${taskRef ? `\n\n${taskRef.trim()}` : ""}`]
    : [headings.background, "", `${description}${taskRef}`];

  const scopePlaceholder = isEn ? "- Task change area" : "- タスク変更箇所";
  const reviewBranchLabel = isEn ? "review branch" : "review branch";
  const reviewCommitLabel = isEn ? "review commit" : "review commit";

  const lines = [
    ...backgroundSection,
    "",
    headings.changes,
    "",
    `- ${task.title}`,
    `- ${reviewBranchLabel}: ${branchName}`,
    `- ${reviewCommitLabel}: ${commitSha}`,
    "",
    headings.scope,
    "",
    scopePlaceholder,
    "",
    headings.verification,
    "",
    ...verificationLines,
    "",
    headings.other,
    "",
    "- ",
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
  const raw = runCommand("gh", ["pr", "list", "--head", branchName, "--state", "all", "--json", "url", "--limit", "1"], cwd, exec);
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

  // `workspace.branchName` is the authoritative signal: it is set iff
  // prepareTaskWorkspace actually created a git worktree on a fresh
  // branch. This covers every precedence path (explicit WORKFLOW.md,
  // global setting, or hard-coded default) without re-checking
  // `workflow.workspaceMode`, which is now tri-state.
  if (!workspace.branchName) {
    return {
      ...result,
      syncStatus: "not_applicable",
    };
  }

  if (!options?.skipRepositoryGuard) {
    try {
      assertRepositoryIdentity(
        task.id,
        workspace.cwd,
        parseExpectedRepositoryUrls(task.repository_urls, task.repository_url),
      );
    } catch (error) {
      result.syncError = `repository preflight failed: ${
        error instanceof RepositoryIdentityError || error instanceof Error
          ? error.message
          : String(error)
      }`;
      return result;
    }
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
    const existingPrUrl = lookupExistingPrUrl(workspace.cwd, result.branchName!, exec);
    const prBody = buildPrBody(
      task,
      result.branchName!,
      result.commitSha!,
      options?.executedCommands,
      options?.language,
    );
    if (existingPrUrl) {
      // Overwrite existing PR body to ensure consistent format (no duplicated sections)
      try {
        runCommand(
          "gh",
          ["pr", "edit", existingPrUrl, "--body", prBody],
          workspace.cwd,
          exec,
        );
      } catch {
        // Ignore edit failures; the PR still exists
      }
      result.prUrl = existingPrUrl;
    } else {
      result.prUrl = runCommand(
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
          prBody,
        ],
        workspace.cwd,
        exec,
      );
    }
    result.syncStatus = result.prUrl ? "pr_open" : "pushed";
  } catch (error) {
    result.syncError = `pr failed: ${commandErrorToMessage(error)}`;
  }

  return result;
}
