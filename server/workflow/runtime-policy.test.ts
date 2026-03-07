import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAgentRuntimePolicy } from "./runtime-policy.js";

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
      },
    );

    assert.equal(policy.localhostAllowed, true);
    assert.equal(policy.canAgentRunE2E, true);
    assert.match(policy.summary, /localhost listen: allowed/i);
  });
});
