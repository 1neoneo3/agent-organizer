import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentArgs } from "./cli-tools.js";

describe("buildAgentArgs", () => {
  it("keeps full-auto for the default codex sandbox profile", () => {
    assert.deepEqual(buildAgentArgs("codex"), [
      "codex",
      "exec",
      "--json",
      "--full-auto",
    ]);
  });

  it("uses explicit sandbox + -c approval_policy for non-default codex config", () => {
    // codex CLI v0.116+ removed --ask-for-approval. Approval policy now
    // goes through -c approval_policy=<value>.
    assert.deepEqual(
      buildAgentArgs("codex", {
        codexSandboxMode: "danger-full-access",
        codexApprovalPolicy: "never",
      }),
      [
        "codex",
        "exec",
        "--json",
        "--sandbox",
        "danger-full-access",
        "-c",
        "approval_policy=never",
      ],
    );
  });

  it("adds shell environment inheritance when GitHub token passthrough is enabled", () => {
    assert.deepEqual(
      buildAgentArgs("codex", {
        codexSandboxMode: "danger-full-access",
        codexApprovalPolicy: "never",
        shellEnvironmentInheritAll: true,
      }),
      [
        "codex",
        "exec",
        "--json",
        "--sandbox",
        "danger-full-access",
        "-c",
        "approval_policy=never",
        "-c",
        "shell_environment_policy.inherit=all",
      ],
    );
  });
});
