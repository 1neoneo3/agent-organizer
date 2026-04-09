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
          enableTestGeneration: false,
          enableHumanReview: false,
          enablePreDeploy: false,
          projectType: "generic" as const,
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
          enableTestGeneration: false,
          enableHumanReview: false,
          enablePreDeploy: false,
          projectType: "generic" as const,
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
});
