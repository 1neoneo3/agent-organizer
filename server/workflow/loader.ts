import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type E2EExecutionMode = "agent" | "host" | "ci";
export type WorkflowPromptKind = "task" | "review" | "decompose";
export type ProjectType = "typescript" | "python" | "dbt" | "generic";

export interface ProjectWorkflow {
  body: string;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  e2eExecution: E2EExecutionMode;
  e2eCommand: string | null;
  gitWorkflow: "default" | "none";
  /**
   * Tri-state so callers can distinguish an explicit WORKFLOW.md opt-in
   * or opt-out from "no value set":
   *   - `"shared"`       — explicitly run every task in the main checkout
   *   - `"git-worktree"` — explicitly isolate each task in a worktree
   *   - `null`           — not specified in WORKFLOW.md; callers fall
   *                        back to the `default_workspace_mode` global
   *                        setting (default: `"git-worktree"`).
   */
  workspaceMode: "shared" | "git-worktree" | null;
  branchPrefix: string;
  beforeRun: string[];
  afterRun: string[];
  formatCommand?: string | null;
  includeTask: boolean;
  includeReview: boolean;
  includeDecompose: boolean;
  /**
   * Stage toggles are tri-state:
   *   - `true`  — explicitly enabled in WORKFLOW.md
   *   - `false` — explicitly disabled in WORKFLOW.md
   *   - `null`  — not specified; `resolveActiveStages` will fall back to
   *              the global `default_enable_*` setting
   */
  enableRefinement: boolean | null;
  enableTestGeneration: boolean | null;
  enableHumanReview: boolean | null;
  enableCiCheck: boolean | null;
  projectType: ProjectType;
  /**
   * Per-project auto-check commands. Each of these is a bash shell
   * command (executed via `bash -lc`) that runs at pr_review entry in
   * parallel with the LLM reviewer. Missing or empty string = skip
   * that check kind.
   *
   * When a field is `null`, the auto-checks module falls back to the
   * global settings key of the same name (e.g. `check_types_cmd`) for
   * backward compatibility with pre-WORKFLOW.md deployments.
   */
  checkTypesCmd: string | null;
  checkLintCmd: string | null;
  checkTestsCmd: string | null;
  /**
   * E2E check command. Runs in parallel with other checks at
   * pr_review entry. Given E2E suites are typically slower than unit
   * tests, operators should consider whether blocking pr_review on
   * E2E is the right tradeoff for their project.
   */
  checkE2eCmd: string | null;
}

const DEFAULT_WORKFLOW: ProjectWorkflow = {
  body: "",
  codexSandboxMode: "workspace-write",
  codexApprovalPolicy: "on-request",
  e2eExecution: "host",
  e2eCommand: null,
  gitWorkflow: "default",
  workspaceMode: null,
  branchPrefix: "ao",
  beforeRun: [],
  afterRun: [],
  formatCommand: null,
  includeTask: true,
  includeReview: true,
  includeDecompose: true,
  // null → fall back to the global default_enable_* setting at resolve time
  enableRefinement: null,
  enableTestGeneration: null,
  enableHumanReview: null,
  enableCiCheck: null,
  projectType: "generic",
  checkTypesCmd: null,
  checkLintCmd: null,
  checkTestsCmd: null,
  checkE2eCmd: null,
};

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function parseCommandList(value: string): string[] {
  if (!value) {
    return [];
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        );
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
      case "format_command":
        workflow.formatCommand = value || null;
        break;
      case "include_task": {
        const parsed = parseBoolean(value);
        if (parsed !== null) {
          workflow.includeTask = parsed;
        }
        break;
      }
      case "include_review": {
        const parsed = parseBoolean(value);
        if (parsed !== null) {
          workflow.includeReview = parsed;
        }
        break;
      }
      case "include_decompose": {
        const parsed = parseBoolean(value);
        if (parsed !== null) {
          workflow.includeDecompose = parsed;
        }
        break;
      }
      case "enable_refinement": {
        const parsed = parseBoolean(value);
        if (parsed !== null) {
          workflow.enableRefinement = parsed;
        }
        break;
      }
      case "enable_test_generation": {
        const parsed = parseBoolean(value);
        if (parsed !== null) {
          workflow.enableTestGeneration = parsed;
        }
        break;
      }
      case "enable_human_review": {
        const parsed = parseBoolean(value);
        if (parsed !== null) {
          workflow.enableHumanReview = parsed;
        }
        break;
      }
      case "enable_ci_check": {
        const parsed = parseBoolean(value);
        if (parsed !== null) {
          workflow.enableCiCheck = parsed;
        }
        break;
      }
      case "project_type":
        if (value === "typescript" || value === "python" || value === "dbt" || value === "generic") {
          workflow.projectType = value;
        }
        break;
      case "check_types_cmd":
        workflow.checkTypesCmd = value || null;
        break;
      case "check_lint_cmd":
        workflow.checkLintCmd = value || null;
        break;
      case "check_tests_cmd":
        workflow.checkTestsCmd = value || null;
        break;
      case "check_e2e_cmd":
        workflow.checkE2eCmd = value || null;
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
