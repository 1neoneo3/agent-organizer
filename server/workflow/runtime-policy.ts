import type { Agent } from "../types/runtime.js";
import type { ProjectWorkflow } from "./loader.js";

export interface AgentRuntimePolicy {
  provider: Agent["cli_provider"];
  codexSandboxMode: ProjectWorkflow["codexSandboxMode"] | null;
  codexApprovalPolicy: ProjectWorkflow["codexApprovalPolicy"] | null;
  localhostAllowed: boolean;
  canAgentRunE2E: boolean;
  e2eExecution: ProjectWorkflow["e2eExecution"];
  e2eCommand: string | null;
  summary: string;
}

export function resolveAgentRuntimePolicy(
  agent: Pick<Agent, "cli_provider">,
  workflow: ProjectWorkflow | null,
): AgentRuntimePolicy {
  const codexSandboxMode = workflow?.codexSandboxMode ?? "workspace-write";
  const codexApprovalPolicy = workflow?.codexApprovalPolicy ?? "on-request";
  const e2eExecution = workflow?.e2eExecution ?? "host";
  const e2eCommand = workflow?.e2eCommand ?? null;
  const isCodex = agent.cli_provider === "codex";
  const localhostAllowed =
    !isCodex || codexSandboxMode === "danger-full-access";
  const canAgentRunE2E = e2eExecution === "agent" && localhostAllowed;

  const segments = [`Provider: ${agent.cli_provider}`];
  if (isCodex) {
    segments.push(`Codex sandbox: ${codexSandboxMode}`);
    segments.push(`Codex approval policy: ${codexApprovalPolicy}`);
  }
  segments.push(
    `Localhost listen: ${localhostAllowed ? "allowed" : "blocked by sandbox"}`,
  );

  if (canAgentRunE2E) {
    segments.push("Playwright E2E: agent may run locally");
  } else if (e2eExecution === "host") {
    segments.push("Playwright E2E: delegate to host execution");
  } else if (e2eExecution === "ci") {
    segments.push("Playwright E2E: delegate to CI");
  } else {
    segments.push(
      "Playwright E2E: agent execution requested but current runtime cannot listen on localhost",
    );
  }

  if (e2eCommand) {
    segments.push(`Suggested E2E command: ${e2eCommand}`);
  }

  return {
    provider: agent.cli_provider,
    codexSandboxMode: isCodex ? codexSandboxMode : null,
    codexApprovalPolicy: isCodex ? codexApprovalPolicy : null,
    localhostAllowed,
    canAgentRunE2E,
    e2eExecution,
    e2eCommand,
    summary: `${segments.join(". ")}.`,
  };
}
