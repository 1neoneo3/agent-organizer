import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { prepareTaskWorkspace } from "./workspace-manager.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ao-worktree-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "ao@example.com");
  git(dir, "config", "user.name", "Agent Organizer");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "init");
  return dir;
}

describe("prepareTaskWorkspace", () => {
  it("returns the original project path for shared mode", () => {
    const repo = initRepo();
    const workspace = prepareTaskWorkspace(
      {
        id: "task-1",
        title: "Shared task",
        task_number: "#1",
        project_path: repo,
      } as never,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: null,
        gitWorkflow: "default",
        workspaceMode: "shared",
        branchPrefix: "ao",
        beforeRun: [],
        afterRun: [],
        includeTask: true,
        includeReview: true,
        includeDecompose: true,
          enableTestGeneration: false,
          enableHumanReview: false,
          enableCiCheck: false,
          projectType: "generic" as const,
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
      },
    );

    assert.equal(workspace.cwd, repo);
    assert.equal(workspace.branchName, null);
  });

  it("creates a deterministic git worktree for the task", () => {
    const repo = initRepo();
    const workflow = {
      body: "",
      codexSandboxMode: "workspace-write" as const,
      codexApprovalPolicy: "on-request" as const,
      e2eExecution: "host" as const,
      e2eCommand: null,
      gitWorkflow: "default" as const,
      workspaceMode: "git-worktree" as const,
      branchPrefix: "issue",
      beforeRun: [],
      afterRun: [],
      includeTask: true,
      includeReview: true,
      includeDecompose: true,
          enableTestGeneration: false,
          enableHumanReview: false,
          enableCiCheck: false,
          projectType: "generic" as const,
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
    };

    const workspace = prepareTaskWorkspace(
      {
        id: "task-2",
        title: "Add workflow support",
        task_number: "#42",
        project_path: repo,
      } as never,
      workflow,
    );

    assert.equal(workspace.rootPath, repo);
    assert.match(workspace.branchName ?? "", /^issue\/t42-add-workflow-support$/);
    assert.equal(existsSync(workspace.cwd), true);
    assert.equal(git(workspace.cwd, "rev-parse", "--abbrev-ref", "HEAD"), workspace.branchName);
  });
});
