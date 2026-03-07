import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTaskPrompt } from "./prompt-builder.js";

describe("buildTaskPrompt", () => {
  it("includes runtime constraints and workflow guidance for delegated e2e", () => {
    const prompt = buildTaskPrompt(
      {
        id: "task-1",
        title: "Run E2E safely",
        description: "Need Playwright coverage.",
        project_path: "/tmp/project",
      } as never,
      {
        runtimePolicy: {
          provider: "codex",
          codexSandboxMode: "workspace-write",
          codexApprovalPolicy: "on-request",
          localhostAllowed: false,
          canAgentRunE2E: false,
          e2eExecution: "host",
          e2eCommand: "pnpm test:e2e",
          summary: "Localhost listen: blocked. Delegate E2E to host execution.",
        },
        workflow: {
          body: "Keep changes focused.",
          codexSandboxMode: "workspace-write",
          codexApprovalPolicy: "on-request",
          e2eExecution: "host",
          e2eCommand: "pnpm test:e2e",
        },
      },
    );

    assert.match(prompt, /Localhost listen: blocked/);
    assert.match(prompt, /Delegate E2E to host execution/);
    assert.match(prompt, /pnpm test:e2e/);
    assert.match(prompt, /Keep changes focused/);
  });
});
