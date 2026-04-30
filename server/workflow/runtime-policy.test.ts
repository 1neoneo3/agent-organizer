import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolveAgentRuntimePolicy } from "./runtime-policy.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

function initGitRepo(remoteUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ao-runtime-policy-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "ao@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Agent Organizer"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("resolveAgentRuntimePolicy", () => {
  it("marks localhost as blocked for sandboxed codex runs", () => {
    const policy = resolveAgentRuntimePolicy(
      { cli_provider: "codex" } as never,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: "pnpm test:e2e",
        gitWorkflow: "default",
        workspaceMode: "shared",
        branchPrefix: "ao",
        beforeRun: [],
        afterRun: [],
        includeTask: true,
        includeReview: true,
        includeDecompose: true,
        enableRefinement: null,
        enableTestGeneration: false,
        enableHumanReview: false,
        projectType: "generic" as const,
        checkTypesCmd: null,
        checkLintCmd: null,
        checkTestsCmd: null,
        checkE2eCmd: null,
      },
    );

    assert.equal(policy.localhostAllowed, false);
    assert.equal(policy.canAgentRunE2E, false);
    assert.match(policy.summary, /localhost listen: blocked/i);
    assert.match(policy.summary, /delegate/i);
  });

  it("allows agent-side e2e when codex runs without sandbox restrictions", () => {
    const policy = resolveAgentRuntimePolicy(
      { cli_provider: "codex" } as never,
      {
        body: "",
        codexSandboxMode: "danger-full-access",
        codexApprovalPolicy: "never",
        e2eExecution: "agent",
        e2eCommand: "pnpm test:e2e",
        gitWorkflow: "default",
        workspaceMode: "shared",
        branchPrefix: "ao",
        beforeRun: [],
        afterRun: [],
        includeTask: true,
        includeReview: true,
        includeDecompose: true,
          enableRefinement: null,
  enableTestGeneration: false,
          enableHumanReview: false,
          projectType: "generic" as const,
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
      },
    );

    assert.equal(policy.localhostAllowed, true);
    assert.equal(policy.canAgentRunE2E, true);
    assert.match(policy.summary, /localhost listen: allowed/i);
  });

  it("enables GitHub write when the repo matches the allow-list", () => {
    const repo = initGitRepo("https://github.com/acme/widgets.git");
    const policy = resolveAgentRuntimePolicy(
      { cli_provider: "codex" } as never,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: null,
        gitWorkflow: "default",
        workspaceMode: "git-worktree",
        branchPrefix: "ao",
        beforeRun: [],
        afterRun: [],
        includeTask: true,
        includeReview: true,
        includeDecompose: true,
        enableRefinement: null,
        enableTestGeneration: false,
        enableHumanReview: false,
        projectType: "generic" as const,
        checkTypesCmd: null,
        checkLintCmd: null,
        checkTestsCmd: null,
        checkE2eCmd: null,
      },
      {
        mode: "enabled",
        allowedRepos: "acme/widgets",
        tokenPassthrough: true,
        projectPath: repo,
      },
    );

    assert.equal(policy.githubWriteAllowed, true);
    assert.equal(policy.githubWriteMode, "enabled");
    assert.equal(policy.githubWriteTokenPassthrough, true);
    assert.equal(policy.codexSandboxMode, "workspace-write");
    assert.match(policy.summary, /GitHub write: enabled/i);
  });

  it("blocks GitHub write when the repo is not on the allow-list", () => {
    const repo = initGitRepo("https://github.com/acme/widgets.git");
    const policy = resolveAgentRuntimePolicy(
      { cli_provider: "codex" } as never,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: null,
        gitWorkflow: "default",
        workspaceMode: "git-worktree",
        branchPrefix: "ao",
        beforeRun: [],
        afterRun: [],
        includeTask: true,
        includeReview: true,
        includeDecompose: true,
        enableRefinement: null,
        enableTestGeneration: false,
        enableHumanReview: false,
        projectType: "generic" as const,
        checkTypesCmd: null,
        checkLintCmd: null,
        checkTestsCmd: null,
        checkE2eCmd: null,
      },
      {
        mode: "enabled",
        allowedRepos: "acme/other-repo",
        tokenPassthrough: false,
        projectPath: repo,
      },
    );

    assert.equal(policy.githubWriteAllowed, false);
    assert.equal(policy.codexSandboxMode, "workspace-write");
    assert.ok(policy.githubWriteReason);
    assert.match(policy.githubWriteReason, /allow-list/i);
    assert.match(policy.summary, /GitHub write: disabled/i);
  });
});
