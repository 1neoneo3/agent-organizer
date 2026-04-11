import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadProjectWorkflow, shouldIncludeWorkflow } from "./loader.js";

describe("loadProjectWorkflow", () => {
  it("returns null when WORKFLOW.md is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-workflow-"));

    assert.equal(loadProjectWorkflow(dir), null);
  });

  it("loads markdown body without frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-workflow-"));
    writeFileSync(join(dir, "WORKFLOW.md"), "# Custom Flow\n\nRun formatter first.\n");

    const workflow = loadProjectWorkflow(dir);

    assert.equal(workflow?.body, "# Custom Flow\n\nRun formatter first.");
    assert.equal(workflow?.gitWorkflow, "default");
    assert.equal(workflow?.codexSandboxMode, "workspace-write");
    assert.equal(workflow?.includeTask, true);
  });

  it("parses runtime and workflow frontmatter flags together", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-workflow-"));
    writeFileSync(
      join(dir, "WORKFLOW.md"),
      [
        "---",
        "codex_sandbox_mode: danger-full-access",
        "codex_approval_policy: never",
        "e2e_execution: host",
        "e2e_command: pnpm test:e2e",
        "git_workflow: none",
        "workspace_mode: git-worktree",
        "branch_prefix: issue",
        "before_run: [\"pnpm install\", \"pnpm lint\"]",
        "after_run: echo done",
        "include_review: false",
        "include_decompose: false",
        "---",
        "Use worktree per issue.",
      ].join("\n"),
    );

    const workflow = loadProjectWorkflow(dir);

    assert.ok(workflow);
    assert.equal(workflow.codexSandboxMode, "danger-full-access");
    assert.equal(workflow.codexApprovalPolicy, "never");
    assert.equal(workflow.e2eExecution, "host");
    assert.equal(workflow.e2eCommand, "pnpm test:e2e");
    assert.equal(workflow.gitWorkflow, "none");
    assert.equal(workflow.workspaceMode, "git-worktree");
    assert.equal(workflow.branchPrefix, "issue");
    assert.deepEqual(workflow.beforeRun, ["pnpm install", "pnpm lint"]);
    assert.deepEqual(workflow.afterRun, ["echo done"]);
    assert.equal(workflow.includeTask, true);
    assert.equal(workflow.includeReview, false);
    assert.equal(workflow.includeDecompose, false);
    assert.equal(workflow.body, "Use worktree per issue.");
  });
});

describe("shouldIncludeWorkflow", () => {
  it("respects per-prompt flags", () => {
    const workflow = {
      body: "workflow",
      codexSandboxMode: "workspace-write" as const,
      codexApprovalPolicy: "on-request" as const,
      e2eExecution: "host" as const,
      e2eCommand: null,
      gitWorkflow: "none" as const,
      workspaceMode: "shared" as const,
      branchPrefix: "ao",
      beforeRun: [],
      afterRun: [],
      includeTask: true,
      includeReview: false,
      includeDecompose: false,
          enableTestGeneration: false,
          enableHumanReview: false,
          enablePreDeploy: false,
          projectType: "generic" as const,
    };

    assert.equal(shouldIncludeWorkflow(workflow, "task"), true);
    assert.equal(shouldIncludeWorkflow(workflow, "review"), false);
    assert.equal(shouldIncludeWorkflow(workflow, "decompose"), false);
  });
});

describe("loadProjectWorkflow — enable_* fields", () => {
  it("parses enable_test_generation, enable_human_review, enable_pre_deploy from frontmatter", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ao-test-"));
    writeFileSync(join(tmpDir, "WORKFLOW.md"), `---
enable_test_generation: true
enable_human_review: true
enable_pre_deploy: false
---
Custom workflow body
`);

    const result = loadProjectWorkflow(tmpDir);
    assert.ok(result);
    assert.equal(result.enableTestGeneration, true);
    assert.equal(result.enableHumanReview, true);
    assert.equal(result.enablePreDeploy, false);
    assert.equal(result.body, "Custom workflow body");

    rmSync(tmpDir, { recursive: true });
  });

  it("leaves enable_* as null when not specified (falls back to settings at resolve time)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ao-test-"));
    writeFileSync(join(tmpDir, "WORKFLOW.md"), `---
git_workflow: none
---
Body
`);

    const result = loadProjectWorkflow(tmpDir);
    assert.ok(result);
    assert.equal(result.enableTestGeneration, null);
    assert.equal(result.enableHumanReview, null);
    assert.equal(result.enablePreDeploy, null);

    rmSync(tmpDir, { recursive: true });
  });
});
