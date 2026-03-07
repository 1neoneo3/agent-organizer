import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type WorkflowPromptKind = "task" | "review" | "decompose";

export interface ProjectWorkflow {
  body: string;
  gitWorkflow: "default" | "none";
  workspaceMode: "shared" | "git-worktree";
  branchPrefix: string;
  beforeRun: string[];
  afterRun: string[];
  includeTask: boolean;
  includeReview: boolean;
  includeDecompose: boolean;
}

const DEFAULT_WORKFLOW: ProjectWorkflow = {
  body: "",
  gitWorkflow: "default",
  workspaceMode: "shared",
  branchPrefix: "ao",
  beforeRun: [],
  afterRun: [],
  includeTask: true,
  includeReview: true,
  includeDecompose: true,
};

function parseCommandList(value: string): string[] {
  if (!value) return [];

  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
      }
    } catch {
      return [];
    }
  }

  return [value];
}

function parseBoolean(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseFrontmatter(raw: string): ProjectWorkflow {
  const workflow: ProjectWorkflow = { ...DEFAULT_WORKFLOW };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");

    switch (key) {
      case "git_workflow":
        if (value === "default" || value === "none") {
          workflow.gitWorkflow = value;
        }
        break;
      case "workspace_mode":
        if (value === "shared" || value === "git-worktree") {
          workflow.workspaceMode = value;
        }
        break;
      case "branch_prefix":
        if (value) {
          workflow.branchPrefix = value;
        }
        break;
      case "before_run":
        workflow.beforeRun = parseCommandList(value);
        break;
      case "after_run":
        workflow.afterRun = parseCommandList(value);
        break;
      case "include_task": {
        const parsed = parseBoolean(value);
        if (parsed !== null) workflow.includeTask = parsed;
        break;
      }
      case "include_review": {
        const parsed = parseBoolean(value);
        if (parsed !== null) workflow.includeReview = parsed;
        break;
      }
      case "include_decompose": {
        const parsed = parseBoolean(value);
        if (parsed !== null) workflow.includeDecompose = parsed;
        break;
      }
      default:
        break;
    }
  }

  return workflow;
}

export function loadProjectWorkflow(projectPath: string | null): ProjectWorkflow | null {
  if (!projectPath) return null;

  const workflowPath = join(projectPath, "WORKFLOW.md");
  if (!existsSync(workflowPath)) return null;

  const raw = readFileSync(workflowPath, "utf-8");
  const normalized = raw.trim();
  if (!normalized) return null;

  if (!normalized.startsWith("---")) {
    return { ...DEFAULT_WORKFLOW, body: normalized };
  }

  const endMarker = normalized.indexOf("\n---", 3);
  if (endMarker === -1) {
    return { ...DEFAULT_WORKFLOW, body: normalized };
  }

  const frontmatter = normalized.slice(4, endMarker).trim();
  const body = normalized.slice(endMarker + 4).trim();
  return {
    ...parseFrontmatter(frontmatter),
    body,
  };
}

export function shouldIncludeWorkflow(
  workflow: ProjectWorkflow | null,
  kind: WorkflowPromptKind,
): boolean {
  if (!workflow) return false;

  switch (kind) {
    case "task":
      return workflow.includeTask;
    case "review":
      return workflow.includeReview;
    case "decompose":
      return workflow.includeDecompose;
    default:
      return false;
  }
}
