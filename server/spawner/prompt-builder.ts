import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Task, Directive } from "../types/runtime.js";
import type { ProjectWorkflow, ProjectType } from "../workflow/loader.js";
import type { AgentRuntimePolicy } from "../workflow/runtime-policy.js";

// ---------------------------------------------------------------------------
// Shared context loaders
// ---------------------------------------------------------------------------

interface RuleSnippet {
  name: string;
  content: string;
}

/** Load all `~/.claude/rules/*.md` files. */
function loadRules(): RuleSnippet[] {
  const rulesDir = join(homedir(), ".claude", "rules");
  try {
    const files = readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
    return files.map((f) => ({
      name: f.replace(/\.md$/, ""),
      content: readFileSync(join(rulesDir, f), "utf-8"),
    }));
  } catch {
    return [];
  }
}

/**
 * Extract file paths mentioned in task description and search for
 * recent merged PRs touching those paths to inject as context.
 */
function extractContextFromTask(task: Task): string {
  if (!task.description || !task.project_path) return "";

  // Extract file paths from description
  const pathPattern = /(?:[\w./]+\/[\w.-]+\.(?:ts|tsx|js|jsx|py|sql|yml|yaml|json|md))/g;
  const paths = [...new Set(task.description.match(pathPattern) ?? [])];
  if (paths.length === 0) return "";

  const parts: string[] = [];
  parts.push("## Auto-Injected Context");
  parts.push("");
  parts.push("The following file paths were detected in the task description:");
  for (const p of paths.slice(0, 10)) {
    parts.push(`- \`${p}\``);
  }
  parts.push("");

  // Try to find recent merged PRs touching these paths
  try {
    const { execFileSync } = require("node:child_process");
    const pathArgs = paths.slice(0, 5).map(p => `-- ${p}`).join(" ");
    const gitLog = execFileSync("git", [
      "log", "--oneline", "--merges", "-10",
      "--", ...paths.slice(0, 5),
    ], {
      cwd: task.project_path,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    if (gitLog) {
      parts.push("Recent merged commits touching these files:");
      parts.push("```");
      parts.push(gitLog);
      parts.push("```");
      parts.push("");
    }
  } catch {
    // git not available or not a git repo — skip
  }

  return parts.join("\n");
}

/** Load `CLAUDE.md` from the project root if it exists. */
function loadProjectInstructions(projectPath: string | null): string | null {
  if (!projectPath) return null;
  const claudeMdPath = join(projectPath, "CLAUDE.md");
  try {
    if (existsSync(claudeMdPath)) {
      return readFileSync(claudeMdPath, "utf-8");
    }
  } catch {
    /* ignore */
  }
  return null;
}

interface SkillSnippet {
  name: string;
  content: string;
}

/**
 * Load skill snippets from:
 *   1. ~/.claude/skills/<dir>/SKILL.md  (standard skills)
 *   2. ~/.claude/skills/learned/*.md    (learned skills)
 *
 * Budget: max 2000 chars per skill, max 50 KB total.
 */
function loadSkillSnippets(): SkillSnippet[] {
  const skillsDir = join(homedir(), ".claude", "skills");
  const snippets: SkillSnippet[] = [];

  try {
    // 1. ~/.claude/skills/*/SKILL.md
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "learned") {
        const skillMd = join(skillsDir, entry.name, "SKILL.md");
        if (existsSync(skillMd)) {
          snippets.push({
            name: entry.name,
            content: readFileSync(skillMd, "utf-8"),
          });
        }
      }
    }

    // 2. ~/.claude/skills/learned/*.md
    const learnedDir = join(skillsDir, "learned");
    try {
      const learnedFiles = readdirSync(learnedDir).filter((f) =>
        f.endsWith(".md"),
      );
      for (const f of learnedFiles) {
        snippets.push({
          name: `learned/${f.replace(/\.md$/, "")}`,
          content: readFileSync(join(learnedDir, f), "utf-8"),
        });
      }
    } catch {
      /* learned dir may not exist */
    }
  } catch {
    return [];
  }

  // Budget control
  const MAX_PER_SKILL = 2000;
  const MAX_TOTAL = 50_000;
  let total = 0;
  const result: SkillSnippet[] = [];

  for (const s of snippets) {
    const truncated = s.content.slice(0, MAX_PER_SKILL);
    if (total + truncated.length > MAX_TOTAL) break;
    total += truncated.length;
    result.push({ name: s.name, content: truncated });
  }

  return result;
}

/** Append rules and CLAUDE.md sections to a prompt parts array. */
function appendSharedContext(
  parts: string[],
  projectPath: string | null,
): void {
  // Project instructions (CLAUDE.md)
  const projectInstructions = loadProjectInstructions(projectPath);
  if (projectInstructions) {
    parts.push("## Project Instructions (CLAUDE.md)");
    parts.push("");
    parts.push(projectInstructions);
    parts.push("");
  }

  // User rules
  const rules = loadRules();
  if (rules.length > 0) {
    parts.push("## Rules");
    parts.push("");
    for (const rule of rules) {
      parts.push(`### ${rule.name}`);
      parts.push(rule.content);
      parts.push("");
    }
  }
}

function appendWorkflowContext(
  parts: string[],
  workflow?: ProjectWorkflow | null,
  runtimePolicy?: AgentRuntimePolicy | null,
): void {
  if (!workflow && !runtimePolicy) {
    return;
  }

  parts.push("## Runtime Constraints");
  parts.push("");

  if (runtimePolicy) {
    parts.push(runtimePolicy.summary);
    parts.push("");

    if (!runtimePolicy.canAgentRunE2E) {
      parts.push(
        "Do not start a localhost-listening Playwright webServer inside the agent unless the runtime explicitly allows it.",
      );
      if (runtimePolicy.e2eExecution === "host") {
        parts.push(
          "Delegate E2E to the host environment and report the exact command to run.",
        );
      } else if (runtimePolicy.e2eExecution === "ci") {
        parts.push(
          "Delegate E2E to CI and report the exact workflow or command to run.",
        );
      }
      if (runtimePolicy.e2eCommand) {
        parts.push(`Preferred E2E command: \`${runtimePolicy.e2eCommand}\``);
      }
      parts.push("");
    }
  }

  if (workflow?.body) {
    parts.push("## Project Workflow (WORKFLOW.md)");
    parts.push("");
    parts.push(workflow.body);
    parts.push("");
  }
}

// ---------------------------------------------------------------------------
// Public prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the full prompt to send to a CLI agent, including task info and skill injections.
 */
export function buildTaskPrompt(
  task: Task,
  opts?: {
    selfReview?: boolean;
    workflow?: ProjectWorkflow | null;
    runtimePolicy?: AgentRuntimePolicy | null;
  },
): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  // Inject CLAUDE.md + rules
  appendSharedContext(parts, task.project_path);

  // Inject auto-detected context (file paths, recent PRs)
  const autoContext = extractContextFromTask(task);
  if (autoContext) {
    parts.push(autoContext);
    parts.push("");
  }

  parts.push(`# Task: ${task.title}`);
  parts.push("");
  if (task.description) {
    parts.push(task.description);
    parts.push("");
  }
  if (task.project_path) {
    parts.push(`Project path: ${task.project_path}`);
    parts.push("");
  }

  parts.push("## Sprint Contract (Required Before Implementation)");
  parts.push("");
  parts.push("Before writing ANY code, output a sprint contract in this format:");
  parts.push("");
  parts.push("---SPRINT CONTRACT---");
  parts.push("**Deliverables:**");
  parts.push("1. [specific file/feature]");
  parts.push("2. [specific file/feature]");
  parts.push("");
  parts.push("**Acceptance Criteria:**");
  parts.push("- [ ] [testable criterion 1]");
  parts.push("- [ ] [testable criterion 2]");
  parts.push("- [ ] [testable criterion 3]");
  parts.push("");
  parts.push("**Out of Scope:**");
  parts.push("- [what you will NOT do]");
  parts.push("---END CONTRACT---");
  parts.push("");
  parts.push("This contract will be used by the QA agent to verify your work.");
  parts.push("After outputting the contract, proceed with implementation.");
  parts.push("");
  // Inject format command if configured in WORKFLOW.md
  if (opts?.workflow?.formatCommand) {
    parts.push("## Auto-Format (MUST run after every file change)");
    parts.push("");
    parts.push(`After editing any file, run: \`${opts.workflow.formatCommand}\``);

    parts.push("This ensures consistent formatting without manual effort.");
    parts.push("");
  }

  parts.push("## Mandatory Pre-Completion Checklist (MUST DO before finishing)");
  parts.push("");
  parts.push("Before you declare your work done, you MUST run ALL of the following and fix any issues:");
  parts.push("");
  parts.push("1. **Lint**: Run `npm run lint` (or the project's lint command). Fix ALL errors and warnings. Zero tolerance.");
  parts.push("2. **Build**: Run `npm run build` (or the project's build command). It MUST succeed with zero errors.");
  parts.push("3. **Type check**: Run `npx tsc --noEmit` if TypeScript. Fix all type errors.");
  parts.push("4. **Run the code**: Actually execute the code/app and verify it works. Do not assume — verify.");
  parts.push("5. **Console errors**: If it's a web app, check for browser console errors (hydration, runtime, etc.).");
  parts.push("6. **Framework compatibility**: Verify your code is compatible with the ACTUAL version installed (check package.json). Do not use deprecated or removed APIs.");
  parts.push("");
  parts.push("If ANY of these checks fail, fix the issue BEFORE completing. Do NOT leave known issues for later.");
  parts.push("A task that introduces lint errors, build failures, or runtime errors is NOT done — it is broken.");
  parts.push("");
  parts.push("## Prohibited Actions");
  parts.push("- Do NOT create new tasks in Agent Organizer (no ao-cli.sh, no POST /api/tasks)");
  parts.push("- Do NOT call AO API endpoints — your only job is to implement the current task");
  parts.push("");

  appendWorkflowContext(parts, opts?.workflow, opts?.runtimePolicy);

  // Self-review instruction
  if (opts?.selfReview) {
    parts.push("## Review Instructions");
    parts.push(
      "After completing the task, perform a self-review of your changes:",
    );
    parts.push("1. Verify the implementation meets the task requirements");
    parts.push("2. Check for obvious bugs, security issues, or regressions");
    parts.push("3. Confirm tests pass (if applicable)");
    parts.push(
      '4. Output a final line: `[SELF_REVIEW:PASS]` or `[SELF_REVIEW:FAIL:<reason>]`',
    );
    parts.push("");
  }

  // PR creation workflow (default for tasks that produce file changes)
  parts.push("## Git Workflow");
  parts.push("");
  parts.push("If your work produces file changes, you MUST follow this workflow:");
  parts.push("1. Create a new branch from main: `git checkout main && git pull origin main && git checkout -b <branch-name>`");
  parts.push("   - Branch naming: `feat/<topic>`, `fix/<topic>`, `refactor/<topic>`, etc.");
  parts.push("2. Make your changes and commit with conventional commit messages");
  parts.push("3. Push the branch: `git push -u origin <branch-name>`");
  parts.push("4. Create a PR: `gh pr create --title \"<type>: <description>\" --body \"<summary of changes>\"`");
  parts.push("5. **NEVER commit directly to main**");
  parts.push("");

  // Inject relevant skills
  const skills = loadSkillSnippets();
  if (skills.length > 0) {
    parts.push("## Available Skills");
    parts.push("");
    for (const skill of skills) {
      parts.push(`### ${skill.name}`);
      parts.push(skill.content);
      parts.push("");
    }
  }

  // CEO Feedback file reference
  const feedbackPath = join("data", "feedback", `${task.id}.md`);
  if (existsSync(feedbackPath)) {
    parts.push("## CEO Feedback");
    parts.push("");
    parts.push(
      `There is active CEO feedback for this task. Read the file at: ${feedbackPath}`,
    );
    parts.push(
      "Check this file periodically for new directives and adjust your work accordingly.",
    );
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Build a prompt that instructs the AI to decompose a directive into numbered tasks
 * with dependency tracking, plus a Markdown implementation plan.
 */
/**
 * Build a prompt for an Explore phase (read-only investigation).
 * The agent investigates the codebase without making any changes,
 * then outputs a structured implementation plan.
 */
export function buildExplorePrompt(task: Task): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  appendSharedContext(parts, task.project_path);

  parts.push("# Explore Phase: Investigation Only");
  parts.push("");
  parts.push("**CRITICAL CONSTRAINT: DO NOT modify any files. Read-only investigation only.**");
  parts.push("");
  parts.push(`## Task: ${task.title}`);
  parts.push("");
  if (task.description) {
    parts.push(task.description);
    parts.push("");
  }
  if (task.project_path) {
    parts.push(`Project path: ${task.project_path}`);
    parts.push("");
  }

  parts.push("## Your Mission");
  parts.push("");
  parts.push("1. Read and understand the relevant code, dependencies, and patterns");
  parts.push("2. Identify all files that need to be created or modified");
  parts.push("3. Check for existing patterns, conventions, and similar implementations");
  parts.push("4. Identify potential risks and edge cases");
  parts.push("");

  parts.push("## Output Format");
  parts.push("");
  parts.push("Output your findings as a structured plan:");
  parts.push("");
  parts.push("---EXPLORE RESULT---");
  parts.push("**Relevant Files:**");
  parts.push("- path/to/file.ts (reason for relevance)");
  parts.push("");
  parts.push("**Existing Patterns:**");
  parts.push("- Pattern description (file reference)");
  parts.push("");
  parts.push("**Implementation Plan:**");
  parts.push("1. Step 1: what to do and where");
  parts.push("2. Step 2: ...");
  parts.push("");
  parts.push("**Risks/Edge Cases:**");
  parts.push("- Risk description");
  parts.push("---END EXPLORE---");
  parts.push("");
  parts.push("IMPORTANT: Do NOT create, edit, or write any files. Only read and analyze.");

  return parts.join("\n");
}

/**
 * Build a prompt for an automated code review run.
 * The reviewer agent checks the implementation and outputs a verdict marker.
 */
export function buildReviewPrompt(task: Task): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  // Inject CLAUDE.md + rules
  appendSharedContext(parts, task.project_path);

  parts.push("# Code Review Task");
  parts.push("");
  parts.push(`You are reviewing the implementation for: **${task.title}**`);
  parts.push("");
  if (task.description) {
    parts.push("## Original Task Description");
    parts.push(task.description);
    parts.push("");
  }
  if (task.project_path) {
    parts.push(`Project path: ${task.project_path}`);
    parts.push("");
  }

  parts.push("## Sprint Contract Reference");
  parts.push("Check the task logs for a ---SPRINT CONTRACT--- from the implementation phase.");
  parts.push("Verify the implementation satisfies the stated deliverables and acceptance criteria.");
  parts.push("");

  parts.push("## Review Instructions");
  parts.push("");
  parts.push("1. Run `git diff HEAD~1` and `git log --oneline -5` to understand recent changes");
  parts.push("2. If the code is runnable, actually run it and any existing tests to verify correctness");
  parts.push("");

  parts.push("## Mandatory Build/Lint Gate (check FIRST)");
  parts.push("");
  parts.push("Before scoring, verify these pass. ANY failure = automatic [REVIEW:NEEDS_CHANGES]:");
  parts.push("1. `npm run lint` — zero errors and zero warnings");
  parts.push("2. `npm run build` — success with zero errors");
  parts.push("3. `npx tsc --noEmit` if TypeScript — zero type errors");
  parts.push("4. Run the app and check for runtime/console errors");
  parts.push("");
  parts.push("If any gate fails, output [REVIEW:NEEDS_CHANGES:<which gate failed>] immediately.");
  parts.push("Do NOT give passing scores to code that doesn't build or lint.");
  parts.push("");

  parts.push("## Review Checklist");
  parts.push("");
  parts.push("Grade each aspect (1-5):");
  parts.push("1. **Correctness** - Does the code do what the task asks?");
  parts.push("2. **Code Quality** - Is it clean, readable, well-structured? Proper naming, no duplication");
  parts.push("3. **Error Handling** - Are edge cases and boundary conditions handled?");
  parts.push("4. **Completeness** - Are all requirements from the task description met?");
  parts.push("5. **Security** - No hardcoded secrets, injection vulnerabilities, or unsafe patterns?");
  parts.push("");
  parts.push("## Report Format");
  parts.push("");
  parts.push("For each aspect, provide:");
  parts.push("```");
  parts.push("REVIEW RESULTS:");
  parts.push("Correctness:    [X/5] - Evidence: <what you verified>");
  parts.push("Code Quality:   [X/5] - Evidence: <specific observations>");
  parts.push("Error Handling: [X/5] - Evidence: <what you checked>");
  parts.push("Completeness:   [X/5] - Evidence: <requirements coverage>");
  parts.push("Security:       [X/5] - Evidence: <what you checked>");
  parts.push("```");
  parts.push("");
  parts.push("## Scoring Threshold");
  parts.push("");
  parts.push("- 4-5 on all aspects → `[REVIEW:PASS]`");
  parts.push("- Any aspect scored 1-2 → `[REVIEW:NEEDS_CHANGES:<aspects to fix>]`");
  parts.push("- Mixed 3s → Use judgment, lean toward PASS if functionally complete");
  parts.push("");
  parts.push("## Example Review (for calibration)");
  parts.push("");
  parts.push('Task: "Add user authentication middleware"');
  parts.push("");
  parts.push("REVIEW RESULTS:");
  parts.push("Correctness:    [5/5] - Evidence: middleware correctly validates JWT tokens, tested with valid/invalid/expired tokens");
  parts.push("Code Quality:   [4/5] - Evidence: clean separation of concerns, good naming, minor: one function could be extracted");
  parts.push("Error Handling: [4/5] - Evidence: handles missing token, expired token, malformed token; returns appropriate HTTP status codes");
  parts.push("Completeness:   [5/5] - Evidence: all 3 requirements met (JWT validation, role-based access, token refresh)");
  parts.push("Security:       [3/5] - Evidence: tokens validated correctly, but secret is loaded from env (good), rate limiting not implemented");
  parts.push("");
  parts.push("[REVIEW:PASS]");
  parts.push("");
  parts.push("## Verdict");
  parts.push("");
  parts.push("Write a brief review summary (in Japanese), then output your verdict as the **final line**:");
  parts.push("- `[REVIEW:PASS]` — if the implementation is acceptable");
  parts.push("- `[REVIEW:NEEDS_CHANGES:<aspects to fix>]` — if changes are required");
  parts.push("");

  return parts.join("\n");
}

/**
 * Build a prompt for an automated QA testing run.
 * The QA agent verifies the implementation and outputs a verdict marker.
 */
export function buildQaPrompt(task: Task, projectType: ProjectType = "generic"): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  // Inject CLAUDE.md + rules
  appendSharedContext(parts, task.project_path);

  parts.push("# QA Testing Task");
  parts.push("");
  parts.push(`You are a QA engineer testing the implementation of a task.`);
  parts.push("");
  parts.push("## Task Under Test");
  parts.push(`**Title**: ${task.title}`);
  parts.push(`**Description**: ${task.description ?? "No description"}`);
  parts.push(`**Project Path**: ${task.project_path ?? "/home/mk/workspace"}`);
  parts.push(`**Project Type**: ${projectType}`);
  parts.push("");

  parts.push("## Sprint Contract");
  parts.push("Check the task logs for a ---SPRINT CONTRACT--- block from the implementation phase.");
  parts.push("If found, use those acceptance criteria as your primary checklist.");
  parts.push("If not found, derive your own criteria from the task description.");
  parts.push("");

  if (projectType === "dbt") {
    appendDbtQaProcess(parts);
  } else {
    appendGenericQaProcess(parts);
  }

  parts.push("### Verdict");
  parts.push("- If ALL criteria pass: output `[QA:PASS]`");
  parts.push("- If ANY criterion fails: output `[QA:FAIL:<brief summary of failures>]`");
  parts.push("");

  return parts.join("\n");
}

function appendDbtQaProcess(parts: string[]): void {
  parts.push("## dbt QA Process");
  parts.push("");
  parts.push("### Step 1: Mandatory Gates");
  parts.push("Run these FIRST — ANY failure = automatic [QA:FAIL]:");
  parts.push("1. `uv run dbt compile --select <changed_model>+` — コンパイルエラーがないこと");
  parts.push("2. `uv run dbt test --select <changed_model>+` — 全テスト通過");
  parts.push("3. `uv run dbt build --select <changed_model>+` — ビルド＋テスト通過");
  parts.push("");
  parts.push("### Step 2: Schema Validation");
  parts.push("変更されたモデルの schema YAML を確認:");
  parts.push("- 必須カラムに `not_null` テストがあるか");
  parts.push("- 主キーに `unique` テストがあるか");
  parts.push("- 外部キーに `relationships` テストがあるか");
  parts.push("");
  parts.push("### Step 3: Data Quality Check");
  parts.push("BigQueryで実データを確認（サンプルクエリ実行）:");
  parts.push("- 変更後のモデルの出力行数が妥当か（0行やNULLのみでないか）");
  parts.push("- 集計値が期待範囲内か（既知のKPI値があれば比較）");
  parts.push("- JOINの結合漏れがないか（LEFT JOINの場合NULL率を確認）");
  parts.push("");
  parts.push("### Step 4: Report");
  parts.push("```");
  parts.push("CRITERIA RESULTS:");
  parts.push("[PASS/FAIL] dbt compile — Evidence: ...");
  parts.push("[PASS/FAIL] dbt test — Evidence: ...");
  parts.push("[PASS/FAIL] Schema tests exist — Evidence: ...");
  parts.push("[PASS/FAIL] Data quality — Evidence: ...");
  parts.push("OVERALL: X/Y criteria passed");
  parts.push("```");
  parts.push("");
}

function appendGenericQaProcess(parts: string[]): void {
  parts.push("## Your Process");
  parts.push("");
  parts.push("### Step 1: Extract Acceptance Criteria");
  parts.push("From the task description (or the Sprint Contract if available), derive 3-7 concrete, testable acceptance criteria. Each criterion should be binary (pass/fail).");
  parts.push("");

  parts.push("### Step 2: Mandatory Build/Lint Gate (ALWAYS check these FIRST)");
  parts.push("Before checking acceptance criteria, run these and report results:");
  parts.push("1. `npm run lint` (or project lint command) — ANY error = automatic [QA:FAIL]");
  parts.push("2. `npm run build` (or project build command) — ANY error = automatic [QA:FAIL]");
  parts.push("3. `npx tsc --noEmit` if TypeScript — ANY type error = automatic [QA:FAIL]");
  parts.push("4. Run the app/code and check for runtime errors — ANY crash/exception = automatic [QA:FAIL]");
  parts.push("");
  parts.push("If ANY of the above fails, immediately output [QA:FAIL:<reason>] without further testing.");
  parts.push("");

  parts.push("### Step 3: Active Verification of Acceptance Criteria");
  parts.push("For EACH criterion:");
  parts.push("1. **Execute** the relevant command");
  parts.push("2. **Record** the actual result");
  parts.push("3. **Grade** as PASS or FAIL with evidence");
  parts.push("");
  parts.push("IMPORTANT: You MUST actually run the code. Do not just read it and assume it works.");
  parts.push("");

  parts.push("### Step 4: Report");
  parts.push("```");
  parts.push("CRITERIA RESULTS:");
  parts.push("[PASS] Criterion 1 - Evidence: <what you observed>");
  parts.push("[FAIL] Criterion 2 - Evidence: <what went wrong>");
  parts.push("OVERALL: X/Y criteria passed");
  parts.push("```");
  parts.push("");
}

export function buildTestGenerationPrompt(task: Task, projectType: ProjectType = "generic"): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  appendSharedContext(parts, task.project_path);

  parts.push("# Test Generation Task");
  parts.push("");
  parts.push("You are a test engineer. Generate tests for the implementation of this task.");
  parts.push("");
  parts.push("## Task Under Test");
  parts.push(`**Title**: ${task.title}`);
  parts.push(`**Description**: ${task.description ?? "No description"}`);
  parts.push(`**Project Path**: ${task.project_path ?? "/home/mk/workspace"}`);
  parts.push(`**Project Type**: ${projectType}`);
  parts.push("");

  if (projectType === "dbt") {
    appendDbtTestGeneration(parts);
  } else if (projectType === "python") {
    appendPythonTestGeneration(parts);
  } else if (projectType === "typescript") {
    appendTypescriptTestGeneration(parts);
  } else {
    appendGenericTestGeneration(parts);
  }

  return parts.join("\n");
}

function appendDbtTestGeneration(parts: string[]): void {
  parts.push("## dbt テスト生成ガイド");
  parts.push("");
  parts.push("### Step 1: 変更内容の確認");
  parts.push("git diff または変更されたモデルファイルを読み、変更内容を把握する。");
  parts.push("");
  parts.push("### Step 2: Schema Tests（YAML定義）");
  parts.push("変更されたモデルの schema YAML に以下を追加:");
  parts.push("- `not_null`: 必須カラムにNULLがないこと");
  parts.push("- `unique`: ユニークキーの重複がないこと");
  parts.push("- `accepted_values`: ENUMカラムの値が想定内");
  parts.push("- `relationships`: 外部キーの参照整合性");
  parts.push("");
  parts.push("### Step 3: Unit Tests（dbt 1.8+ YAML定義）");
  parts.push("変更されたモデルのロジック検証用 unit test を追加:");
  parts.push("- 固定の入力データ（given）→ 期待される出力（expect）");
  parts.push("- JOINの結合漏れ、フィルタ条件、集計ロジックの検証");
  parts.push("- UNION ALL + NOT EXISTS の重複排除が正しいことの検証");
  parts.push("- 境界値（NULL、空文字、0値）の取り扱い");
  parts.push("");
  parts.push("### Step 4: Data Tests（SQLファイル）");
  parts.push("ビジネスロジックの検証用 data test を `tests/` に作成:");
  parts.push("- `assert_*` 命名規則（例: `assert_delivery_coins_positive.sql`）");
  parts.push("- 「結果が0行なら成功」のパターンで記述");
  parts.push("");
  parts.push("### Step 5: 実行と確認");
  parts.push("```bash");
  parts.push("uv run dbt test --select <changed_model>+");
  parts.push("```");
  parts.push("");
  parts.push("## Output");
  parts.push("- schema YAML にテスト定義を追加");
  parts.push("- 必要に応じて unit test / data test ファイルを作成");
  parts.push("- `dbt test` を実行して全テスト通過を確認");
  parts.push("");
}

function appendPythonTestGeneration(parts: string[]): void {
  parts.push("## Python テスト生成ガイド");
  parts.push("");
  parts.push("### Your Process");
  parts.push("1. 変更されたファイルを読み、テスト対象の関数/クラスを特定");
  parts.push("2. `tests/` ディレクトリに pytest テストを作成");
  parts.push("3. テストカバレッジ:");
  parts.push("   - Happy path（正常系）");
  parts.push("   - Edge cases（境界値、空入力、None）");
  parts.push("   - Error cases（例外、バリデーションエラー）");
  parts.push("4. `pytest` を実行して全テスト通過を確認");
  parts.push("5. 80%+ カバレッジを目指す");
  parts.push("");
  parts.push("### 実行コマンド");
  parts.push("```bash");
  parts.push("python -m pytest --cov=src");
  parts.push("```");
  parts.push("");
}

function appendTypescriptTestGeneration(parts: string[]): void {
  parts.push("## TypeScript テスト生成ガイド");
  parts.push("");
  parts.push("### Your Process");
  parts.push("1. 変更されたファイルを読み、テスト対象を特定");
  parts.push("2. プロジェクトのテストフレームワーク（vitest/jest）に合わせてテストを作成");
  parts.push("3. テストカバレッジ:");
  parts.push("   - Happy path（正常系）");
  parts.push("   - Edge cases（境界値、undefined、null）");
  parts.push("   - Error cases（throw、reject）");
  parts.push("4. テストを実行して全テスト通過を確認");
  parts.push("5. 80%+ カバレッジを目指す");
  parts.push("");
  parts.push("### 実行コマンド");
  parts.push("```bash");
  parts.push("npm run test");
  parts.push("```");
  parts.push("");
}

function appendGenericTestGeneration(parts: string[]): void {
  parts.push("## Your Process");
  parts.push("");
  parts.push("1. Read the implementation changes (use git diff or read modified files)");
  parts.push("2. Identify testable behaviors and edge cases");
  parts.push("3. Write unit tests covering:");
  parts.push("   - Happy path (normal operation)");
  parts.push("   - Edge cases (boundary values, empty inputs, etc.)");
  parts.push("   - Error cases (invalid inputs, failures)");
  parts.push("4. Run the tests to verify they pass");
  parts.push("5. Aim for 80%+ coverage on changed code");
  parts.push("");
  parts.push("## Output");
  parts.push("- Create test files following the project's testing conventions");
  parts.push("- Run all tests and report results");
  parts.push("- If tests fail, fix the tests (not the implementation)");
  parts.push("");
}

export function buildPreDeployPrompt(task: Task): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  appendSharedContext(parts, task.project_path);

  parts.push("# Pre-Deploy Verification Task");
  parts.push("");
  parts.push("You are a DevOps engineer performing pre-deploy verification.");
  parts.push("");
  parts.push("## Task Under Test");
  parts.push(`**Title**: ${task.title}`);
  parts.push(`**Description**: ${task.description ?? "No description"}`);
  parts.push(`**Project Path**: ${task.project_path ?? "/home/mk/workspace"}`);
  parts.push("");

  parts.push("## Verification Checklist");
  parts.push("");
  parts.push("### Step 1: Build Verification");
  parts.push("1. Run `npm run build` (or project build command) — must succeed");
  parts.push("2. Run `npx tsc --noEmit` if TypeScript — must have zero errors");
  parts.push("3. Run `npm run lint` — must pass");
  parts.push("");
  parts.push("### Step 2: Test Verification");
  parts.push("1. Run all tests — must pass");
  parts.push("2. Check test coverage is adequate (80%+ on changed files)");
  parts.push("");
  parts.push("### Step 3: Security Check");
  parts.push("1. No hardcoded secrets (API keys, passwords, tokens)");
  parts.push("2. No console.log statements in production code");
  parts.push("3. Dependencies are up to date (no critical vulnerabilities)");
  parts.push("");
  parts.push("### Step 4: Deployment Readiness");
  parts.push("1. All changes are committed");
  parts.push("2. Branch is up to date with main");
  parts.push("3. PR is created and reviewable");
  parts.push("");

  parts.push("## Verdict");
  parts.push("- If ALL checks pass: output `[PRE_DEPLOY:PASS]`");
  parts.push("- If ANY check fails: output `[PRE_DEPLOY:FAIL:<brief summary>]`");
  parts.push("");

  return parts.join("\n");
}

export function buildDecomposePrompt(directive: Directive): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  // Inject CLAUDE.md + rules so decomposer understands project context
  appendSharedContext(parts, directive.project_path);

  parts.push(
    "You are a project manager AI. Your job is to decompose the following directive into concrete, actionable tasks with numbered IDs and dependency tracking.",
  );
  parts.push("");
  parts.push(`# Directive: ${directive.title}`);
  parts.push("");
  parts.push(directive.content);
  parts.push("");
  if (directive.project_path) {
    parts.push(`Project path: ${directive.project_path}`);
    parts.push("");
  }
  parts.push("## Instructions");
  parts.push("");
  parts.push(
    "Break this directive into 2-8 concrete tasks. Each task should be:",
  );
  parts.push("- Specific and actionable (a single agent can complete it)");
  parts.push("- Small to medium in scope");
  parts.push("- Numbered sequentially (T01, T02, T03...)");
  parts.push(
    "- Include dependency information (which tasks must complete before this one)",
  );
  parts.push("");
  parts.push(
    "Respond with TWO sections separated by the exact line `---PLAN---`:",
  );
  parts.push("");
  parts.push(
    "**SECTION 1**: JSON array of tasks (no markdown fences, no extra text before or after the JSON):",
  );
  parts.push("```");
  parts.push(
    JSON.stringify(
      [
        {
          task_id: "T01",
          title: "Set up database schema",
          description: "Detailed description of what to do",
          task_size: "small",
          priority: 10,
          depends_on: [],
        },
        {
          task_id: "T02",
          title: "Implement API endpoints",
          description: "Detailed description",
          task_size: "medium",
          priority: 8,
          depends_on: ["T01"],
        },
      ],
      null,
      2,
    ),
  );
  parts.push("```");
  parts.push("");
  parts.push("---PLAN---");
  parts.push("");
  parts.push("**SECTION 2**: Implementation plan in Markdown:");
  parts.push("```");
  parts.push("# Implementation Plan: {directive title}");
  parts.push("## Overview");
  parts.push("Brief summary of the implementation approach.");
  parts.push("## Task Dependency Graph");
  parts.push(
    "Show which tasks depend on which (e.g. T01 → T02 → T03).",
  );
  parts.push("## Implementation Order");
  parts.push("Recommended execution order with rationale.");
  parts.push("## Risk Analysis");
  parts.push("Potential risks and mitigations.");
  parts.push("## Prerequisites");
  parts.push("What needs to be in place before starting.");
  parts.push("## Estimated Effort");
  parts.push("Rough estimates per task.");
  parts.push("```");
  parts.push("");
  parts.push(
    "Output SECTION 1 (JSON) followed by ---PLAN--- followed by SECTION 2 (Markdown) now:",
  );

  return parts.join("\n");
}
