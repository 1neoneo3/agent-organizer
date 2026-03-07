import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    assert.equal(workflow?.includeTask, true);
  });

  it("parses frontmatter flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-workflow-"));
    writeFileSync(
      join(dir, "WORKFLOW.md"),
      [
        "---",
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

    assert.equal(workflow?.gitWorkflow, "none");
    assert.equal(workflow?.workspaceMode, "git-worktree");
    assert.equal(workflow?.branchPrefix, "issue");
    assert.deepEqual(workflow?.beforeRun, ["pnpm install", "pnpm lint"]);
    assert.deepEqual(workflow?.afterRun, ["echo done"]);
    assert.equal(workflow?.includeTask, true);
    assert.equal(workflow?.includeReview, false);
    assert.equal(workflow?.includeDecompose, false);
    assert.equal(workflow?.body, "Use worktree per issue.");
  });
});

describe("shouldIncludeWorkflow", () => {
  it("respects per-prompt flags", () => {
    const workflow = {
      body: "workflow",
      gitWorkflow: "none" as const,
      workspaceMode: "shared" as const,
      branchPrefix: "ao",
      beforeRun: [],
      afterRun: [],
      includeTask: true,
      includeReview: false,
      includeDecompose: false,
    };

    assert.equal(shouldIncludeWorkflow(workflow, "task"), true);
    assert.equal(shouldIncludeWorkflow(workflow, "review"), false);
    assert.equal(shouldIncludeWorkflow(workflow, "decompose"), false);
  });
});
