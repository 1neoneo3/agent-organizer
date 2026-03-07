import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type E2EExecutionMode = "agent" | "host" | "ci";

export interface ProjectWorkflow {
  body: string;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  e2eExecution: E2EExecutionMode;
  e2eCommand: string | null;
}

const DEFAULT_WORKFLOW: ProjectWorkflow = {
  body: "",
  codexSandboxMode: "workspace-write",
  codexApprovalPolicy: "on-request",
  e2eExecution: "host",
  e2eCommand: null,
};

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function parseFrontmatter(raw: string): ProjectWorkflow {
  const workflow: ProjectWorkflow = { ...DEFAULT_WORKFLOW };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = stripQuotes(trimmed.slice(separator + 1).trim());

    switch (key) {
      case "codex_sandbox_mode":
        if (
          value === "read-only" ||
          value === "workspace-write" ||
          value === "danger-full-access"
        ) {
          workflow.codexSandboxMode = value;
        }
        break;
      case "codex_approval_policy":
        if (
          value === "untrusted" ||
          value === "on-request" ||
          value === "never"
        ) {
          workflow.codexApprovalPolicy = value;
        }
        break;
      case "e2e_execution":
        if (value === "agent" || value === "host" || value === "ci") {
          workflow.e2eExecution = value;
        }
        break;
      case "e2e_command":
        workflow.e2eCommand = value || null;
        break;
      default:
        break;
    }
  }

  return workflow;
}

export function loadProjectWorkflow(
  projectPath: string | null,
): ProjectWorkflow | null {
  if (!projectPath) return null;

  const workflowPath = join(projectPath, "WORKFLOW.md");
  if (!existsSync(workflowPath)) return null;

  const raw = readFileSync(workflowPath, "utf-8").trim();
  if (!raw) return null;

  if (!raw.startsWith("---")) {
    return { ...DEFAULT_WORKFLOW, body: raw };
  }

  const endMarker = raw.indexOf("\n---", 3);
  if (endMarker === -1) {
    return { ...DEFAULT_WORKFLOW, body: raw };
  }

  const frontmatter = raw.slice(4, endMarker).trim();
  const body = raw.slice(endMarker + 4).trim();

  return {
    ...parseFrontmatter(frontmatter),
    body,
  };
}
