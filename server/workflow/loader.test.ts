import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadProjectWorkflow } from "./loader.js";

describe("loadProjectWorkflow", () => {
  it("returns null when WORKFLOW.md is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-organizer-workflow-"));

    const workflow = loadProjectWorkflow(dir);

    assert.equal(workflow, null);
  });

  it("parses codex runtime and e2e settings from frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-organizer-workflow-"));
    writeFileSync(
      join(dir, "WORKFLOW.md"),
      `---
codex_sandbox_mode: danger-full-access
codex_approval_policy: never
e2e_execution: host
e2e_command: pnpm test:e2e
---

# Workflow

Keep changes focused.
`,
    );

    const workflow = loadProjectWorkflow(dir);

    assert.ok(workflow);
    assert.equal(workflow.codexSandboxMode, "danger-full-access");
    assert.equal(workflow.codexApprovalPolicy, "never");
    assert.equal(workflow.e2eExecution, "host");
    assert.equal(workflow.e2eCommand, "pnpm test:e2e");
    assert.match(workflow.body, /Keep changes focused/);
  });
});
