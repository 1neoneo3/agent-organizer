import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "../types/runtime.js";
import { promoteTaskReviewArtifact } from "./review-artifact.js";

describe("promoteTaskReviewArtifact", () => {
  const task = {
    id: "task-1",
    title: "Review artifact promotion",
    task_number: "#12",
    pr_url: null,
  } as Task;

  it("returns not_applicable for shared workspace", () => {
    const result = promoteTaskReviewArtifact(
      task,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: null,
        gitWorkflow: "default",
        workspaceMode: "shared",
        branchPrefix: "issue",
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
      { cwd: "/tmp/shared", branchName: null, rootPath: "/tmp/shared" },
    );

    assert.equal(result.syncStatus, "not_applicable");
    assert.equal(result.prUrl, null);
  });

  it("captures branch, commit, and pr url when promotion succeeds", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const outputs = new Map<string, string>([
      ["git rev-parse --abbrev-ref HEAD", "issue/t12-review-artifact-promotion"],
      ["git status --short", " M changed.ts"],
      ["git rev-parse HEAD", "abc123"],
      ["git symbolic-ref refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
      ["gh pr list --head issue/t12-review-artifact-promotion --state all --json url --limit 1", "[]"],
      [
        `gh pr create --base main --head issue/t12-review-artifact-promotion --title feat: Review artifact promotion --body ## 背景\n\nReview artifact promotion (#12)\n\n## 行った変更\n\n- Review artifact promotion\n- review branch: issue/t12-review-artifact-promotion\n- review commit: abc123\n\n## 影響範囲\n\n- タスク変更箇所\n\n## 動作確認項目\n\n- [ ] CI passed\n\n## その他\n\n- `,
        "https://github.com/example/repo/pull/1",
      ],
    ]);
    const exec = (command: string, args: string[]) => {
      calls.push({ command, args });
      const key = `${command} ${args.join(" ")}`;
      if (outputs.has(key)) {
        return outputs.get(key)!;
      }
      if (key === "git add -A" || key === "git commit -m feat: Review artifact promotion" || key === "git push -u origin issue/t12-review-artifact-promotion") {
        return "";
      }
      throw new Error(`unexpected command: ${key}`);
    };

    const result = promoteTaskReviewArtifact(
      task,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: null,
        gitWorkflow: "default",
        workspaceMode: "git-worktree",
        branchPrefix: "issue",
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
        cwd: "/tmp/worktree",
        branchName: "issue/t12-review-artifact-promotion",
        rootPath: "/tmp/repo",
      },
      { exec: exec as never },
    );

    assert.equal(result.branchName, "issue/t12-review-artifact-promotion");
    assert.equal(result.commitSha, "abc123");
    assert.equal(result.prUrl, "https://github.com/example/repo/pull/1");
    assert.equal(result.syncStatus, "pr_open");
    assert.equal(result.syncError, null);
    assert.equal(calls.some((call) => call.command === "git" && call.args[0] === "push"), true);
  });

  it("produces English PR body headings when language='en'", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let capturedPrBody = "";
    const outputs = new Map<string, string>([
      ["git rev-parse --abbrev-ref HEAD", "issue/t12-en-test"],
      ["git status --short", " M file.ts"],
      ["git rev-parse HEAD", "def456"],
      ["git symbolic-ref refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
      ["gh pr list --head issue/t12-en-test --state all --json url --limit 1", "[]"],
    ]);
    const exec = (command: string, args: string[]) => {
      calls.push({ command, args });
      const key = `${command} ${args.join(" ")}`;
      if (outputs.has(key)) {
        return outputs.get(key)!;
      }
      if (key.startsWith("git add") || key.startsWith("git commit") || key.startsWith("git push")) {
        return "";
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        capturedPrBody = args[args.indexOf("--body") + 1];
        return "https://github.com/example/repo/pull/2";
      }
      throw new Error(`unexpected command: ${key}`);
    };

    const result = promoteTaskReviewArtifact(
      task,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: null,
        gitWorkflow: "default",
        workspaceMode: "git-worktree",
        branchPrefix: "issue",
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
        cwd: "/tmp/worktree-en",
        branchName: "issue/t12-en-test",
        rootPath: "/tmp/repo",
      },
      { exec: exec as never, language: "en" },
    );

    assert.equal(result.syncStatus, "pr_open");
    assert.match(capturedPrBody, /## Background/);
    assert.match(capturedPrBody, /## Changes/);
    assert.match(capturedPrBody, /## Scope/);
    assert.match(capturedPrBody, /## Verification/);
    assert.match(capturedPrBody, /## Other/);
    assert.doesNotMatch(capturedPrBody, /## 背景/);
    assert.doesNotMatch(capturedPrBody, /## 行った変更/);
  });

  it("produces Japanese PR body headings by default (no language option)", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let capturedPrBody = "";
    const outputs = new Map<string, string>([
      ["git rev-parse --abbrev-ref HEAD", "issue/t12-ja-test"],
      ["git status --short", " M file.ts"],
      ["git rev-parse HEAD", "ghi789"],
      ["git symbolic-ref refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
      ["gh pr list --head issue/t12-ja-test --state all --json url --limit 1", "[]"],
    ]);
    const exec = (command: string, args: string[]) => {
      calls.push({ command, args });
      const key = `${command} ${args.join(" ")}`;
      if (outputs.has(key)) {
        return outputs.get(key)!;
      }
      if (key.startsWith("git add") || key.startsWith("git commit") || key.startsWith("git push")) {
        return "";
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        capturedPrBody = args[args.indexOf("--body") + 1];
        return "https://github.com/example/repo/pull/3";
      }
      throw new Error(`unexpected command: ${key}`);
    };

    const result = promoteTaskReviewArtifact(
      task,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: null,
        gitWorkflow: "default",
        workspaceMode: "git-worktree",
        branchPrefix: "issue",
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
        cwd: "/tmp/worktree-ja",
        branchName: "issue/t12-ja-test",
        rootPath: "/tmp/repo",
      },
      { exec: exec as never },
    );

    assert.equal(result.syncStatus, "pr_open");
    assert.match(capturedPrBody, /## 背景/);
    assert.match(capturedPrBody, /## 行った変更/);
    assert.match(capturedPrBody, /## 影響範囲/);
    assert.match(capturedPrBody, /## 動作確認項目/);
    assert.match(capturedPrBody, /## その他/);
    assert.doesNotMatch(capturedPrBody, /## Background/);
  });

  it("includes executed commands in verification section", () => {
    let capturedPrBody = "";
    const outputs = new Map<string, string>([
      ["git rev-parse --abbrev-ref HEAD", "issue/t12-cmds"],
      ["git status --short", " M file.ts"],
      ["git rev-parse HEAD", "cmd123"],
      ["git symbolic-ref refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
      ["gh pr list --head issue/t12-cmds --state all --json url --limit 1", "[]"],
    ]);
    const exec = (command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      if (outputs.has(key)) return outputs.get(key)!;
      if (key.startsWith("git add") || key.startsWith("git commit") || key.startsWith("git push")) return "";
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        capturedPrBody = args[args.indexOf("--body") + 1];
        return "https://github.com/example/repo/pull/4";
      }
      throw new Error(`unexpected command: ${key}`);
    };

    promoteTaskReviewArtifact(
      task,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: null,
        gitWorkflow: "default",
        workspaceMode: "git-worktree",
        branchPrefix: "issue",
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
        cwd: "/tmp/worktree-cmds",
        branchName: "issue/t12-cmds",
        rootPath: "/tmp/repo",
      },
      {
        exec: exec as never,
        executedCommands: ["npm run build", "npm test"],
        language: "en",
      },
    );

    assert.match(capturedPrBody, /\[x\] `npm run build`/);
    assert.match(capturedPrBody, /\[x\] `npm test`/);
  });
});
