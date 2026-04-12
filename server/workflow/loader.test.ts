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
      enableRefinement: false,
      enableTestGeneration: false,
      enableHumanReview: false,
      enableCiCheck: false,
      projectType: "generic" as const,
      checkTypesCmd: null,
      checkLintCmd: null,
      checkTestsCmd: null,
      checkE2eCmd: null,
    };

    assert.equal(shouldIncludeWorkflow(workflow, "task"), true);
    assert.equal(shouldIncludeWorkflow(workflow, "review"), false);
    assert.equal(shouldIncludeWorkflow(workflow, "decompose"), false);
  });
});

describe("loadProjectWorkflow — enable_* fields", () => {
  it("parses enable_test_generation, enable_human_review, enable_ci_check from frontmatter", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ao-test-"));
    writeFileSync(join(tmpDir, "WORKFLOW.md"), `---
enable_test_generation: true
enable_human_review: true
enable_ci_check: false
---
Custom workflow body
`);

    const result = loadProjectWorkflow(tmpDir);
    assert.ok(result);
    assert.equal(result.enableTestGeneration, true);
    assert.equal(result.enableHumanReview, true);
    assert.equal(result.enableCiCheck, false);
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
    assert.equal(result.enableRefinement, null);
    assert.equal(result.enableTestGeneration, null);
    assert.equal(result.enableHumanReview, null);
    assert.equal(result.enableCiCheck, null);

    rmSync(tmpDir, { recursive: true });
  });
});

describe("loadProjectWorkflow — check_* commands", () => {
  it("parses check_types_cmd / check_lint_cmd / check_tests_cmd / check_e2e_cmd", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ao-check-"));
    writeFileSync(
      join(tmpDir, "WORKFLOW.md"),
      [
        "---",
        "project_type: python",
        "check_types_cmd: python -m mypy src",
        "check_lint_cmd: ruff check .",
        "check_tests_cmd: pytest --cov=src -q",
        "check_e2e_cmd: pytest tests/e2e --timeout=300",
        "---",
        "Python project",
      ].join("\n"),
    );

    const result = loadProjectWorkflow(tmpDir);
    assert.ok(result);
    assert.equal(result.projectType, "python");
    assert.equal(result.checkTypesCmd, "python -m mypy src");
    assert.equal(result.checkLintCmd, "ruff check .");
    assert.equal(result.checkTestsCmd, "pytest --cov=src -q");
    assert.equal(result.checkE2eCmd, "pytest tests/e2e --timeout=300");

    rmSync(tmpDir, { recursive: true });
  });

  it("leaves check_* fields null when not specified", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ao-check-"));
    writeFileSync(join(tmpDir, "WORKFLOW.md"), "---\nproject_type: python\n---\nbody\n");

    const result = loadProjectWorkflow(tmpDir);
    assert.ok(result);
    assert.equal(result.checkTypesCmd, null);
    assert.equal(result.checkLintCmd, null);
    assert.equal(result.checkTestsCmd, null);
    assert.equal(result.checkE2eCmd, null);

    rmSync(tmpDir, { recursive: true });
  });

  it("treats empty quoted string as null (skip)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ao-check-"));
    writeFileSync(
      join(tmpDir, "WORKFLOW.md"),
      [
        "---",
        "check_types_cmd: \"\"",
        "check_lint_cmd: ruff check .",
        "---",
        "",
      ].join("\n"),
    );

    const result = loadProjectWorkflow(tmpDir);
    assert.ok(result);
    assert.equal(result.checkTypesCmd, null);
    assert.equal(result.checkLintCmd, "ruff check .");

    rmSync(tmpDir, { recursive: true });
  });
});
