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

  it("uses explicit sandbox flags for host-level codex execution", () => {
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
        "--ask-for-approval",
        "never",
      ],
    );
  });
});
