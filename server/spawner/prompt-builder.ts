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
  parts.push("## 自動検出コンテキスト");
  parts.push("");
  parts.push("タスク説明から以下のファイルパスが検出されました:");
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
      parts.push("これらのファイルに関連する最近のマージコミット:");
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
  // Critical environment constraints — injected before all other context
  parts.push("## CRITICAL: Environment Constraints");
  parts.push("");
  parts.push("- **`rtk` command does NOT exist.** There is NO `RTK.md` file. Never prefix commands with `rtk`. Use `cat`, `sed`, `rg`, `grep`, `find` directly.");
  parts.push("");

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
    /**
     * AO Phase 3: directory boundary injection for parallel implementer +
     * tester execution. When set to "implementer", the prompt tells the
     * agent that a tester is running concurrently in the same worktree and
     * that it must NOT touch any test files/directories. This keeps the
     * two agents' file edits from colliding. Defaults to undefined — the
     * historical serial behavior — when parallel mode is disabled.
     */
    parallelScope?: "implementer" | "tester";
  },
): string {
  // Prompt is built in two halves and joined at the end:
  //   1. `staticParts` — everything that is the same across every task
  //      run for a given project: language, CLAUDE.md + rules, contract
  //      instructions, checklists, git workflow, skills, etc.
  //   2. `dynamicParts` — everything that differs per task: title,
  //      description, project path, auto-extracted context, CEO feedback.
  //
  // Anthropic's prompt cache matches a prefix, so arranging the static
  // content FIRST maximizes cache-reuse across consecutive tasks inside
  // the 5-minute cache window. Previously the task block was interleaved
  // near the top of the prompt, which broke the cachable prefix on every
  // run. This split keeps the semantics identical while shifting the
  // dynamic portion to the tail.
  const staticParts: string[] = [];
  const dynamicParts: string[] = [];

  staticParts.push("## Language");
  staticParts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  staticParts.push("");

  // Inject CLAUDE.md + rules (static per project).
  appendSharedContext(staticParts, task.project_path);

  staticParts.push("## スプリント契約（実装前に必須）");
  staticParts.push("");
  staticParts.push("コードを書く前に、以下の形式でスプリント契約を出力してください:");
  staticParts.push("");
  staticParts.push("---SPRINT CONTRACT---");
  staticParts.push("**成果物:**");
  staticParts.push("1. [具体的なファイル/機能]");
  staticParts.push("2. [具体的なファイル/機能]");
  staticParts.push("");
  staticParts.push("**受け入れ基準:**");
  staticParts.push("- [ ] [テスト可能な基準1]");
  staticParts.push("- [ ] [テスト可能な基準2]");
  staticParts.push("- [ ] [テスト可能な基準3]");
  staticParts.push("");
  staticParts.push("**スコープ外:**");
  staticParts.push("- [やらないこと]");
  staticParts.push("---END CONTRACT---");
  staticParts.push("");
  staticParts.push("この契約はQAエージェントが作業を検証する際に使用されます。");
  staticParts.push("契約を出力した後、実装に進んでください。");
  staticParts.push("");
  // Inject format command if configured in WORKFLOW.md. This is
  // per-project-workflow static content, so it still belongs in the
  // cachable prefix as long as the same workflow is reused.
  if (opts?.workflow?.formatCommand) {
    staticParts.push("## Auto-Format (MUST run after every file change)");
    staticParts.push("");
    staticParts.push(`After editing any file, run: \`${opts.workflow.formatCommand}\``);

    staticParts.push("This ensures consistent formatting without manual effort.");
    staticParts.push("");
  }

  staticParts.push("## 完了前チェックリスト（必須）");
  staticParts.push("");
  staticParts.push("作業完了を宣言する前に、以下を全て実行し、問題があれば修正してください:");
  staticParts.push("");
  staticParts.push("1. **Lint**: `npm run lint`（またはプロジェクトのlintコマンド）を実行。エラー・警告ゼロにすること。");
  staticParts.push("2. **ビルド**: `npm run build`（またはプロジェクトのビルドコマンド）を実行。エラーゼロで成功すること。");
  staticParts.push("3. **型チェック**: TypeScriptの場合 `npx tsc --noEmit` を実行。型エラーを全て修正。");
  staticParts.push("4. **動作確認**: 実際にコード/アプリを実行し、動作を確認すること。推測ではなく検証する。");
  staticParts.push("5. **コンソールエラー**: Webアプリの場合、ブラウザコンソールのエラー（hydration、ランタイム等）を確認。");
  staticParts.push("6. **フレームワーク互換性**: 実際にインストールされているバージョン（package.json参照）との互換性を確認。非推奨APIを使わない。");
  staticParts.push("");
  staticParts.push("いずれかのチェックが失敗した場合、完了前に修正すること。既知の問題を残さない。");
  staticParts.push("lintエラー、ビルド失敗、ランタイムエラーを含むタスクは完了ではなく壊れている。");
  staticParts.push("");
  staticParts.push("## 言語別の慣例 (必須)");
  staticParts.push("");
  staticParts.push("### Python (src レイアウトを使う場合)");
  staticParts.push("Python で `src/<package>/` レイアウトを採用する場合、**`pyproject.toml` に以下の pytest 設定を必ず含めること**。");
  staticParts.push("これがないと `pip install -e .` を先に実行しない限り `pytest` が `ModuleNotFoundError` で失敗し、レビュー時にブロック要因になります:");
  staticParts.push("");
  staticParts.push("```toml");
  staticParts.push("[tool.pytest.ini_options]");
  staticParts.push("pythonpath = [\"src\"]");
  staticParts.push("testpaths = [\"tests\"]");
  staticParts.push("```");
  staticParts.push("");
  staticParts.push("これによって、クローン直後に `cd <repo> && pytest` が editable install なしで通るようになります。");
  staticParts.push("");
  staticParts.push("### Node.js / TypeScript");
  staticParts.push("- `package.json` に `\"lint\"`, `\"build\"`, `\"test\"` の scripts を定義すること。`npm run lint`/`npm run build`/`npm test` が直接通ること。");
  staticParts.push("- TypeScript プロジェクトは `tsconfig.json` を含め、`npx tsc --noEmit` が通ること。");
  staticParts.push("");
  staticParts.push("## 禁止事項");
  staticParts.push("- Agent Organizerに新しいタスクを作成しない（ao-cli.sh、POST /api/tasks 禁止）");
  staticParts.push("- AO APIエンドポイントを呼び出さない — あなたの仕事は現在のタスクの実装のみ");
  staticParts.push("");

  // AO Phase 3: parallel implementer + tester mode.
  //
  // When `parallelScope === "implementer"`, a tester agent is running
  // *concurrently* in the same worktree. We inject an explicit directory
  // boundary so the two agents can't stomp on each other's files. The
  // choice is "single worktree + prompt scope" (Option A in the design
  // doc) rather than spawning a second worktree — cheaper to wire up and
  // matches how `auto-test-gen.ts` already shares the worktree for serial
  // test generation.
  if (opts?.parallelScope === "implementer") {
    staticParts.push("## IMPL_SCOPE（並列モード: 実装担当の作業範囲）");
    staticParts.push("");
    staticParts.push(
      "このタスクは **並列 implementer + tester モード** で実行されています。",
    );
    staticParts.push(
      "別の tester エージェントが同じ worktree で並行してテストを生成しています。",
    );
    staticParts.push("");
    staticParts.push("### あなた（implementer）の作業範囲");
    staticParts.push(
      "- **実装ファイルのみ** を編集する: `src/`, `lib/`, `app/`, `server/`, `client/`, ルート配下のプロダクションコード",
    );
    staticParts.push(
      "- **テストファイルは絶対に編集しない** (do not edit test files):",
    );
    staticParts.push(
      "  - `tests/`, `test/`, `spec/`, `__tests__/` 配下のファイル",
    );
    staticParts.push(
      "  - `*.test.*`, `*.spec.*`, `*_test.py`, `test_*.py` にマッチするファイル",
    );
    staticParts.push(
      "- 既存のテストが壊れた場合も、自分で直さず `[TEST_BREAK] <理由>` とログに書き残して tester に引き継ぐ",
    );
    staticParts.push("");
    staticParts.push("### 衝突回避ルール");
    staticParts.push(
      "- tester が先に触ったファイルを上書きしない（git status で未ステージの変更を尊重する）",
    );
    staticParts.push(
      "- 新規ファイルは自分のスコープ（実装ディレクトリ）内にのみ作成する",
    );
    staticParts.push(
      "- コミット粒度は細かく刻み、テストとの競合が起きたら rebase ではなく追加コミットで解決する",
    );
    staticParts.push("");
  }

  // Per-workflow static context (sandbox mode, localhost allowance, e2e
  // policy). Stable across tasks that share a workflow.
  appendWorkflowContext(staticParts, opts?.workflow, opts?.runtimePolicy);

  // Self-review instruction (conditional — shape depends on opts.selfReview).
  if (opts?.selfReview) {
    staticParts.push("## Review Instructions");
    staticParts.push(
      "After completing the task, perform a self-review of your changes:",
    );
    staticParts.push("1. Verify the implementation meets the task requirements");
    staticParts.push("2. Check for obvious bugs, security issues, or regressions");
    staticParts.push("3. Confirm tests pass (if applicable)");
    staticParts.push(
      '4. Output a final line: `[SELF_REVIEW:PASS]` or `[SELF_REVIEW:FAIL:<reason>]`',
    );
    staticParts.push("");
  }

  // PR creation workflow (default for tasks that produce file changes).
  staticParts.push("## Gitワークフロー");
  staticParts.push("");
  staticParts.push("ファイル変更を伴う場合、以下のワークフローに従うこと:");
  staticParts.push("1. mainからブランチを作成: `git checkout main && git pull origin main && git checkout -b <branch-name>`");
  staticParts.push("   - ブランチ命名規則: `feat/<topic>`, `fix/<topic>`, `refactor/<topic>` 等");
  staticParts.push("2. 変更をコミット（conventional commits形式）");
  staticParts.push("3. ブランチをプッシュ: `git push -u origin <branch-name>`");
  staticParts.push("4. PRを作成: `gh pr create --title \"<type>: <description>\" --body \"<変更の概要>\"`");
  staticParts.push("   - **重要**: PR本文に `## 背景` セクションを書かないこと（システムが自動挿入するため重複を避ける）");
  staticParts.push("   - PR本文では「行った変更」「動作確認項目」のみ簡潔に記載");
  staticParts.push("5. **mainに直接コミットしない**");
  staticParts.push("");

  // Inject relevant skills (static across tasks in a given environment).
  const skills = loadSkillSnippets();
  if (skills.length > 0) {
    staticParts.push("## Available Skills");
    staticParts.push("");
    for (const skill of skills) {
      staticParts.push(`### ${skill.name}`);
      staticParts.push(skill.content);
      staticParts.push("");
    }
  }

  // ----- Dynamic portion starts here. Everything below this boundary is
  // task-specific and will NOT be part of the cache-reused prefix. -----
  dynamicParts.push("---");
  dynamicParts.push("");
  dynamicParts.push(`# Task: ${task.title}`);
  dynamicParts.push("");
  if (task.description) {
    dynamicParts.push(task.description);
    dynamicParts.push("");
  }
  if (task.project_path) {
    dynamicParts.push(`Project path: ${task.project_path}`);
    dynamicParts.push("");
  }

  // Auto-detected context (file paths, recent PRs, git info). Stays at
  // the tail because it derives from the current task state.
  const autoContext = extractContextFromTask(task);
  if (autoContext) {
    dynamicParts.push(autoContext);
    dynamicParts.push("");
  }

  // CEO Feedback file reference — dynamic per task.
  const feedbackPath = join("data", "feedback", `${task.id}.md`);
  if (existsSync(feedbackPath)) {
    dynamicParts.push("## CEO Feedback");
    dynamicParts.push("");
    dynamicParts.push(
      `There is active CEO feedback for this task. Read the file at: ${feedbackPath}`,
    );
    dynamicParts.push(
      "Check this file periodically for new directives and adjust your work accordingly.",
    );
    dynamicParts.push("");
  }

  return [...staticParts, ...dynamicParts].join("\n");
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

  parts.push("# 探索フェーズ: 調査のみ");
  parts.push("");
  parts.push("**重要な制約: ファイルを変更しないでください。読み取り専用の調査のみ。**");
  parts.push("");
  parts.push(`## タスク: ${task.title}`);
  parts.push("");
  if (task.description) {
    parts.push(task.description);
    parts.push("");
  }
  if (task.project_path) {
    parts.push(`プロジェクトパス: ${task.project_path}`);
    parts.push("");
  }

  parts.push("## ミッション");
  parts.push("");
  parts.push("1. 関連するコード、依存関係、パターンを読んで理解する");
  parts.push("2. 作成または変更が必要なファイルを全て特定する");
  parts.push("3. 既存のパターン、規約、類似実装を確認する");
  parts.push("4. 潜在的なリスクとエッジケースを特定する");
  parts.push("");

  parts.push("## 出力形式");
  parts.push("");
  parts.push("調査結果を構造化された計画として出力:");
  parts.push("");
  parts.push("---EXPLORE RESULT---");
  parts.push("**関連ファイル:**");
  parts.push("- path/to/file.ts (関連する理由)");
  parts.push("");
  parts.push("**既存パターン:**");
  parts.push("- パターンの説明 (ファイル参照)");
  parts.push("");
  parts.push("**実装計画:**");
  parts.push("1. ステップ1: 何をどこで行うか");
  parts.push("2. ステップ2: ...");
  parts.push("");
  parts.push("**リスク/エッジケース:**");
  parts.push("- リスクの説明");
  parts.push("---END EXPLORE---");
  parts.push("");
  parts.push("重要: ファイルの作成・編集・書き込みをしないこと。読み取りと分析のみ。");

  return parts.join("\n");
}

export interface ActiveTaskContext {
  task_number: string;
  title: string;
  status: string;
  project_path: string | null;
  description: string | null;
}

export function buildRefinementPrompt(task: Task, activeTasks?: ActiveTaskContext[]): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  appendSharedContext(parts, task.project_path);

  // Inject active tasks context for dependency analysis
  if (activeTasks && activeTasks.length > 0) {
    parts.push("## 現在アクティブなタスク (Active Tasks)");
    parts.push("");
    parts.push("以下のタスクが現在進行中または待機中です。新しいタスクの計画時に、これらとのファイル変更の競合や依存関係を分析してください:");
    parts.push("");
    for (const at of activeTasks) {
      parts.push(`- ${at.task_number} **${at.title}** (${at.status})${at.description ? ` — ${at.description.slice(0, 150)}` : ""}`);
    }
    parts.push("");
  }

  parts.push("# 調整フェーズ: タスク計画の策定");
  parts.push("");
  parts.push("**重要な制約: コードの変更は行わないでください。分析と計画策定のみ。**");
  parts.push("");
  parts.push(`## タスク: ${task.title}`);
  parts.push("");
  if (task.description) {
    parts.push(task.description);
    parts.push("");
  }
  if (task.project_path) {
    parts.push(`プロジェクトパス: ${task.project_path}`);
    parts.push("");
  }

  const contextSnippet = extractContextFromTask(task);
  if (contextSnippet) {
    parts.push(contextSnippet);
    parts.push("");
  }

  parts.push("## ミッション");
  parts.push("");
  parts.push("タスクを分析し、以下の構造化された計画を策定してください。");
  parts.push("コードベースを読み取り、関連ファイル・依存関係・既存パターンを調査した上で、");
  parts.push("具体的かつ実行可能な計画を立ててください。");
  parts.push("");
  parts.push("## 出力形式");
  parts.push("");
  parts.push("以下のフォーマットで出力してください:");
  parts.push("");
  parts.push("---REFINEMENT PLAN---");
  parts.push("");
  parts.push("## 背景 (Background)");
  parts.push("");
  parts.push("このタスクが必要になった経緯・動機を簡潔に説明する（2-3文程度）:");
  parts.push("");
  parts.push("- なぜこの変更が必要なのか");
  parts.push("- 現状の問題点や不足している点");
  parts.push("- このタスクが解決する課題");
  parts.push("");
  parts.push("## 要求 (Business Requirements)");
  parts.push("");
  parts.push("ユーザー・ビジネス視点で「何を実現したいか」を箇条書きで列挙する。技術用語は使わない。");
  parts.push("各項目は `- ` で始める:");
  parts.push("");
  parts.push("- 〇〇画面で△△したい");
  parts.push("- 操作結果が即座に反映されてほしい");
  parts.push("- 設定がブラウザを閉じても保持されてほしい");
  parts.push("- 既存の〇〇機能の動きは変わらないでほしい");
  parts.push("");
  parts.push("## 技術要件 (Technical Requirements)");
  parts.push("");
  parts.push("エンジニア視点で「どう実現するか」の技術的な制約・方針を箇条書きで列挙する。");
  parts.push("各項目は `- ` で始める:");
  parts.push("");
  parts.push("- 使用する既存フック・ライブラリ・パターン");
  parts.push("- データの保存先（localStorage, DB, API等）");
  parts.push("- 状態管理の方式（props, context, store等）");
  parts.push("- API/DB変更の有無");
  parts.push("");
  parts.push("## 受け入れ条件 (Acceptance Criteria)");
  parts.push("");
  parts.push("完了判定の条件をチェックリスト形式で列挙する。");
  parts.push("各項目は `- [ ] ` で始める:");
  parts.push("");
  parts.push("- [ ] 条件1");
  parts.push("- [ ] 条件2");
  parts.push("");
  parts.push("## 期待値 (Expected Outcomes)");
  parts.push("");
  parts.push("完了後の状態を箇条書きで列挙する。");
  parts.push("各項目は `- ` で始める:");
  parts.push("");
  parts.push("- 完了後のユーザー体験");
  parts.push("- 完了後のシステム動作");
  parts.push("- 影響範囲の予測");
  parts.push("");
  parts.push("## 変更対象ファイル (Files to Modify)");
  parts.push("");
  parts.push("既存リポジトリの場合、変更が必要なファイルを全て箇条書きで列挙する。");
  parts.push("各項目は `- ` で始める:");
  parts.push("");
  parts.push("- `path/to/file.ts` — 変更内容の要約");
  parts.push("- `path/to/new-file.ts` — (新規作成) 目的の説明");
  parts.push("");
  parts.push("## 実装計画 (Implementation Plan)");
  parts.push("");
  parts.push("具体的な変更手順を番号付きリストで列挙する。各ステップに対象ファイルを明記する。");
  parts.push("各項目は `1. ` `2. ` のように番号で始める:");
  parts.push("");
  parts.push("1. 対象ファイルと具体的な変更内容");
  parts.push("2. 対象ファイルと具体的な変更内容");
  parts.push("");
  parts.push("## リスク・注意点 (Risks & Considerations)");
  parts.push("");
  parts.push("潜在的なリスクやエッジケースを箇条書きで列挙する。");
  parts.push("各項目は `- ` で始める:");
  parts.push("");
  parts.push("- リスクや注意点");
  parts.push("- 回帰テストが必要な既存機能");
  parts.push("");
  parts.push("## 依存関係・コンフリクト (Dependencies & Conflicts)");
  parts.push("");
  parts.push("現在アクティブなタスクとの関係を分析する。");
  parts.push("各項目は `- ` で始める:");
  parts.push("");
  parts.push("- このタスクの前に完了すべきタスク（依存先）があれば `Blocked by #XX: 理由` で記載");
  parts.push("- 同じファイルを変更するタスクがあれば `Conflicts with #XX: 対象ファイルと競合内容` で記載");
  parts.push("- 並行実行可能な場合は `No conflicts` と記載");
  parts.push("");
  parts.push("## 更新されたタスク説明 (Updated Description)");
  parts.push("");
  parts.push("上記を踏まえた、より詳細で明確なタスク説明文。");
  parts.push("");
  parts.push("---END REFINEMENT---");
  parts.push("");
  parts.push("重要: ファイルの作成・編集・書き込みをしないこと。読み取りと分析のみ。");

  return parts.join("\n");
}

/**
 * Reviewer role for role-aware review prompts and verdict tags.
 *
 * - "code": general code-quality reviewer (correctness, quality, error
 *   handling, completeness, secondary security check). This is the
 *   default and matches the pre-panel review behavior.
 * - "security": dedicated security reviewer — narrower checklist that
 *   focuses on secrets, injection, XSS/CSRF, auth/authz, dependency
 *   vulnerabilities, and data-exposure risks.
 */
export type ReviewerRole = "code" | "security";

export interface BuildReviewPromptOptions {
  /**
   * Which reviewer role this prompt is for. Defaults to `"code"` for
   * backward compatibility with the pre-panel single-reviewer flow.
   */
  reviewerRole?: ReviewerRole;
}

/**
 * Build a prompt for an automated code review run.
 *
 * The reviewer agent checks the implementation and outputs a verdict
 * marker. When `reviewerRole` is provided, the prompt is tailored to
 * that role and the reviewer is instructed to emit a role-tagged
 * verdict (`[REVIEW:<role>:PASS]` / `[REVIEW:<role>:NEEDS_CHANGES]`)
 * so that the stage-pipeline aggregator can distinguish verdicts from
 * different reviewers operating on the same task in parallel.
 */
export function buildReviewPrompt(
  task: Task,
  options: BuildReviewPromptOptions = {},
): string {
  const reviewerRole: ReviewerRole = options.reviewerRole ?? "code";
  const isSecurityReviewer = reviewerRole === "security";
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  // Inject CLAUDE.md + rules
  appendSharedContext(parts, task.project_path);

  parts.push(isSecurityReviewer ? "# セキュリティレビュータスク" : "# コードレビュータスク");
  parts.push("");
  if (isSecurityReviewer) {
    parts.push(
      "あなたは **セキュリティレビュー専門** の reviewer です。Code reviewer と並列に実行されているため、一般的な品質・完全性の観点は別担当が見ます。**セキュリティ観点だけ** に集中してください。",
    );
    parts.push("");
  }
  parts.push(`以下の実装をレビューしてください: **${task.title}**`);
  parts.push("");
  if (task.description) {
    parts.push("## 元のタスク説明");
    parts.push(task.description);
    parts.push("");
    parts.push("### ⚠️ タスク説明のメタ情報について");
    parts.push("タスク説明には `## 検証対象機能`, `## 検証方法`, `## 検証対象` のようなメタ情報セクションが含まれる場合があります。");
    parts.push("これらは **agent-organizer システム本体を運用者が確認するためのメタ情報** であり、");
    parts.push("**この実装リポジトリとは無関係** です。以下の点に注意してください:");
    parts.push("");
    parts.push("- メタ情報で言及される「commit XXXXX」や「別リポジトリの機能」は、この実装リポジトリには **存在しません**。");
    parts.push("- 実装リポジトリで `git rev-parse --verify <commit-sha>` が失敗しても、それは欠陥ではありません。");
    parts.push("- レビューは **実際に作られた成果物 (リポジトリ内のコード)** が **SPRINT CONTRACT の成果物と受け入れ基準** を満たしているかだけで判断してください。");
    parts.push("- メタ情報だけを理由に `[REVIEW:NEEDS_CHANGES]` を出さないこと。");
    parts.push("");
  }
  if (task.project_path) {
    parts.push(`プロジェクトパス (親 workspace): ${task.project_path}`);
    parts.push("");
  }
  if (task.repository_url) {
    // Guess the repo's local directory inside project_path from the last
    // URL path segment. Reviewers cannot rely on `project_path` alone
    // because agents often create a NEW repo as a subdirectory inside
    // it (e.g. `/home/mk/workspace/verify4-tempconv-cli`). Running
    // `npm run lint` from the parent walks up and picks up an unrelated
    // project's config — that was the exact failure mode we saw with
    // the verify1-12 batch.
    const repoName = task.repository_url.split("/").pop()?.replace(/\.git$/, "") ?? null;
    parts.push(`リポジトリ URL: ${task.repository_url}`);
    if (repoName) {
      parts.push(`**想定ローカル作業ディレクトリ**: \`${task.project_path}/${repoName}\``);
      parts.push(`レビューコマンドは必ず \`cd ${task.project_path}/${repoName}\` してから実行してください。親ディレクトリの無関係な設定を拾わないこと。`);
    }
    parts.push("");
  }

  parts.push("## スプリント契約の参照");
  parts.push("タスクログから ---SPRINT CONTRACT--- ブロックを確認してください。");
  parts.push("実装が記載された成果物と受け入れ基準を満たしているか検証してください。");
  parts.push("");

  parts.push("## 実作業ディレクトリの特定（必須・最初）");
  parts.push("");
  parts.push("レビュー開始前に **必ず** 以下を実行して、コマンドの実行場所を確定してください:");
  parts.push("");
  parts.push("1. `git -C <候補ディレクトリ> rev-parse --show-toplevel` で git 管理下のリポジトリ root を特定");
  parts.push("2. project_path そのものは agent-organizer の workspace 親ディレクトリの可能性が高いので、そのままでは **使わない**");
  parts.push("3. エージェントが新規作成したリポジトリは、task_logs の `gh repo create` / `git init` / `cd <path>` コマンドから特定可能");
  parts.push("4. 特定した作業ディレクトリに `cd` してから以下のゲートを実行");
  parts.push("");

  parts.push("## 必須ビルド/Lintゲート（最初にチェック）");
  parts.push("");
  parts.push("**実際の作業ディレクトリ** (上で特定した git toplevel) にいる前提で、プロジェクトの言語を自動検出して適切なコマンドを実行してください:");
  parts.push("");
  parts.push("| 設定ファイル存在 | プロジェクト種別 | 実行するゲート |");
  parts.push("|------|------|------|");
  parts.push("| `pyproject.toml` | Python | `ruff check .` (あれば) / `pytest` / `mypy src` (あれば) |");
  parts.push("| `package.json` (+ `tsconfig.json`) | TypeScript | `npm run lint` / `npm run build` / `npx tsc --noEmit` |");
  parts.push("| `package.json` のみ | Node.js | `npm run lint` (あれば) / `npm test` |");
  parts.push("| `go.mod` | Go | `go vet ./...` / `go build ./...` / `go test ./...` |");
  parts.push("| `Cargo.toml` | Rust | `cargo clippy` / `cargo build` / `cargo test` |");
  parts.push("| `dbt_project.yml` | dbt | `dbt compile` / `dbt test --select <model>` |");
  parts.push("| 上記のいずれも無し | Generic | ゲートをスキップして、README や実行可能ファイルの存在確認のみ |");
  parts.push("");
  parts.push("**重要ルール**:");
  parts.push("- スクリプトが**定義されていない**ゲート (例: Python プロジェクトで `npm run lint`) は **実行しないこと**。未定義を理由に NEEDS_CHANGES にしない。");
  parts.push("- 親ディレクトリの設定を拾って別プロジェクトのコマンドを実行したことによる失敗は、`NEEDS_CHANGES` の理由にしない (そもそもゲート対象外)。");
  parts.push("- 定義されたゲートが失敗した場合のみ `[REVIEW:NEEDS_CHANGES:<失敗したゲート>]` を出力。");
  parts.push("");
  parts.push("### Python プロジェクトの pytest 特別ルール");
  parts.push("");
  parts.push("`pytest` を実行して `ModuleNotFoundError` で収集失敗する場合、それは **pyproject.toml の `pythonpath` 未設定** が原因で、**editable install すれば通る標準的な状態** です。以下の手順で再試行してください:");
  parts.push("");
  parts.push("1. `python3 -m venv .venv-review && .venv-review/bin/pip install -e '.[dev]'` を実行 (dev extras がなければ `.venv-review/bin/pip install -e .`)");
  parts.push("2. `.venv-review/bin/pytest --cov=src --cov-report=term-missing` でテストを再実行");
  parts.push("3. **install 後に green なら pytest ゲートは PASS** として扱う。coverage が受け入れ基準を満たしていれば Correctness/Completeness は高スコアで OK");
  parts.push("4. 同時に「`pyproject.toml` の `[tool.pytest.ini_options] pythonpath = [\"src\"]` を追加すれば editable install なしで pytest が通るようになる」と **改善提案として報告**。これは **強制の NEEDS_CHANGES ではなく、Recommendation 扱い**");
  parts.push("5. editable install 後も pytest が落ちる場合のみ `NEEDS_CHANGES`");
  parts.push("");
  parts.push("editable install は Python 開発の標準ワークフローなので、`pytest` の raw 実行失敗だけで NEEDS_CHANGES にしないこと。");
  parts.push("");
  parts.push("4. 最後にアプリを実行してランタイム/コンソールエラーを確認 (可能な場合)");
  parts.push("");

  if (isSecurityReviewer) {
    parts.push("## セキュリティレビューチェックリスト");
    parts.push("");
    parts.push("各観点を1-5で採点 (1=重大な問題あり / 5=問題なし):");
    parts.push("1. **シークレット管理** - API key / token / password / DB credentials がハードコードされていないか？ `.env` 経由か？ commit に混入していないか？");
    parts.push("2. **インジェクション耐性** - SQL injection (parameterized query 使用), command injection (shell=true / exec 系の危険な引数), path traversal の防御");
    parts.push("3. **XSS / CSRF / 出力エスケープ** - ユーザー入力のサニタイズ, innerHTML/dangerouslySetInnerHTML, CSRF token, SameSite cookie");
    parts.push("4. **認証 / 認可** - auth middleware の抜け道, 権限チェック不足, 署名検証の有無, セッション固定, JWT の alg=none");
    parts.push("5. **依存関係 & データ露出** - 既知脆弱性のある library, verbose error message での情報漏洩, ログへの PII/secret 流出, CORS の過剰許可");
    parts.push("");
    parts.push("## レポート形式");
    parts.push("");
    parts.push("各観点について以下を記載:");
    parts.push("```");
    parts.push("SECURITY REVIEW RESULTS:");
    parts.push("Secret Management:  [X/5] - Evidence: <何を確認したか>");
    parts.push("Injection:          [X/5] - Evidence: <確認した query / exec パターン>");
    parts.push("XSS/CSRF:           [X/5] - Evidence: <サニタイズ / token / cookie 設定>");
    parts.push("AuthN/AuthZ:        [X/5] - Evidence: <middleware / 権限チェック>");
    parts.push("Deps & Exposure:    [X/5] - Evidence: <依存関係 / log / error>");
    parts.push("```");
    parts.push("");
    parts.push("## 合格基準");
    parts.push("");
    parts.push("- 全観点4-5 → `[REVIEW:security:PASS]`");
    parts.push("- いずれかの観点が1-2 (= 重大な脆弱性) → `[REVIEW:security:NEEDS_CHANGES:<危険な観点>]`");
    parts.push("- 3が混在 → 実害の有無で判定。理論上の懸念のみなら PASS 寄り");
    parts.push("");
    parts.push("## 判定（必須）");
    parts.push("");
    parts.push("**重要: レビュー出力には必ず以下のいずれかの判定タグを含めてください。タグがない場合、セキュリティレビューは無効とみなされタスクが停止します。**");
    parts.push("");
    parts.push("レビューの要約を日本語で記述し、**最終行**に判定を出力:");
    parts.push("- `[REVIEW:security:PASS]` — セキュリティ上の重大問題なし");
    parts.push("- `[REVIEW:security:NEEDS_CHANGES:<危険な観点>]` — 修正が必要");
    parts.push("");
    parts.push("判定タグの出力を忘れないでください。これがないとワークフローが進行しません。Code reviewer と並列実行中なので、一般品質の指摘は不要です。**セキュリティだけ**見てください。");
    parts.push("");
  } else {
    parts.push("## レビューチェックリスト");
    parts.push("");
    parts.push("各観点を1-5で採点:");
    parts.push("1. **正確性** - コードはタスクの要求通りに動作するか？");
    parts.push("2. **コード品質** - クリーンで読みやすく、構造化されているか？命名、重複なし");
    parts.push("3. **エラーハンドリング** - エッジケースや境界条件が処理されているか？");
    parts.push("4. **完全性** - タスク説明の全要件が満たされているか？");
    parts.push("5. **セキュリティ** - ハードコードされた秘密情報、インジェクション脆弱性、危険なパターンはないか？（※ security_reviewer と並列実行中の場合は二次チェック扱いで OK）");
    parts.push("");
    parts.push("## レポート形式");
    parts.push("");
    parts.push("各観点について以下を記載:");
    parts.push("```");
    parts.push("REVIEW RESULTS:");
    parts.push("Correctness:    [X/5] - Evidence: <what you verified>");
    parts.push("Code Quality:   [X/5] - Evidence: <specific observations>");
    parts.push("Error Handling: [X/5] - Evidence: <what you checked>");
    parts.push("Completeness:   [X/5] - Evidence: <requirements coverage>");
    parts.push("Security:       [X/5] - Evidence: <what you checked>");
    parts.push("```");
    parts.push("");
    parts.push("## 合格基準");
    parts.push("");
    parts.push("- 全観点4-5 → `[REVIEW:code:PASS]`");
    parts.push("- いずれかの観点が1-2 → `[REVIEW:code:NEEDS_CHANGES:<修正すべき観点>]`");
    parts.push("- 3が混在 → 判断に委ねる。機能的に完成していればPASS寄り");
    parts.push("");
    parts.push("## レビュー例（採点基準の参考）");
    parts.push("");
    parts.push('タスク: "ユーザー認証ミドルウェアの追加"');
    parts.push("");
    parts.push("REVIEW RESULTS:");
    parts.push("Correctness:    [5/5] - Evidence: middleware correctly validates JWT tokens, tested with valid/invalid/expired tokens");
    parts.push("Code Quality:   [4/5] - Evidence: clean separation of concerns, good naming, minor: one function could be extracted");
    parts.push("Error Handling: [4/5] - Evidence: handles missing token, expired token, malformed token; returns appropriate HTTP status codes");
    parts.push("Completeness:   [5/5] - Evidence: all 3 requirements met (JWT validation, role-based access, token refresh)");
    parts.push("Security:       [3/5] - Evidence: tokens validated correctly, but secret is loaded from env (good), rate limiting not implemented");
    parts.push("");
    parts.push("[REVIEW:code:PASS]");
    parts.push("");
    parts.push("## 判定（必須）");
    parts.push("");
    parts.push("**重要: レビュー出力には必ず以下のいずれかの判定タグを含めてください。タグがない場合、レビューは無効とみなされタスクが停止します。**");
    parts.push("");
    parts.push("レビューの要約を日本語で記述し、**最終行**に判定を出力:");
    parts.push("- `[REVIEW:code:PASS]` — 実装が許容範囲の場合");
    parts.push("- `[REVIEW:code:NEEDS_CHANGES:<修正すべき観点>]` — 変更が必要な場合");
    parts.push("");
    parts.push("**後方互換**: 旧形式の `[REVIEW:PASS]` / `[REVIEW:NEEDS_CHANGES:<理由>]` も引き続き受理されますが、新規出力には必ず `code` role を付けてください。");
    parts.push("");
    parts.push("判定タグの出力を忘れないでください。これがないとワークフローが進行しません。");
    parts.push("");
  }

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

  parts.push("# QAテストタスク");
  parts.push("");
  parts.push("あなたはQAエンジニアとして、タスクの実装をテストします。");
  parts.push("");
  parts.push("## テスト対象タスク");
  parts.push(`**タイトル**: ${task.title}`);
  parts.push(`**説明**: ${task.description ?? "説明なし"}`);
  parts.push(`**プロジェクトパス**: ${task.project_path ?? "/home/mk/workspace"}`);
  parts.push(`**プロジェクトタイプ**: ${projectType}`);
  parts.push("");

  parts.push("## スプリント契約");
  parts.push("タスクログから ---SPRINT CONTRACT--- ブロックを確認してください。");
  parts.push("見つかった場合、その受け入れ基準をチェックリストとして使用してください。");
  parts.push("見つからない場合、タスク説明から独自の基準を導出してください。");
  parts.push("");

  if (projectType === "dbt") {
    appendDbtQaProcess(parts);
  } else if (projectType === "python") {
    appendPythonQaProcess(parts);
  } else if (projectType === "typescript") {
    appendTypescriptQaProcess(parts);
  } else {
    appendGenericQaProcess(parts);
  }

  parts.push("### 判定");
  parts.push("- 全基準が合格: `[QA:PASS]` を出力");
  parts.push("- いずれかの基準が不合格: `[QA:FAIL:<不合格の簡潔な要約>]` を出力");
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

function appendPythonQaProcess(parts: string[]): void {
  parts.push("## Python QA Process");
  parts.push("");
  parts.push("### Step 1: Mandatory Gates");
  parts.push("Run these FIRST — ANY failure = automatic [QA:FAIL]:");
  parts.push("1. `ruff check .` — lint エラーがないこと (別の linter を使っているなら `flake8` / `pylint` 等に読み替える)");
  parts.push("2. `python -m mypy src` — 型エラーがないこと (`mypy` が無いなら `pyright` / `pyre` に読み替える; type hint 無しプロジェクトはスキップ可)");
  parts.push("3. `python -m pytest -q` — 全テスト通過すること (`uv run pytest` / `poetry run pytest` など環境に合わせる)");
  parts.push("4. 実装されたコマンド/エントリポイントを**実際に実行**してランタイムエラーを確認 — crash/exception があれば即 [QA:FAIL]");
  parts.push("");
  parts.push("上記のいずれかが失敗した場合、即座に [QA:FAIL:<理由>] を出力し、以降のテストは不要。");
  parts.push("");
  parts.push("### Step 2: Coverage Gate");
  parts.push("```bash");
  parts.push("python -m pytest --cov=src --cov-report=term-missing");
  parts.push("```");
  parts.push("- 変更された関数/クラスが未カバーの場合は [QA:FAIL]");
  parts.push("- プロジェクト全体カバレッジ 80% 未満の場合は警告 (FAIL にはしないが REPORT に記載)");
  parts.push("");
  parts.push("### Step 3: Acceptance Criteria Verification");
  parts.push("タスク説明から受け入れ基準を3-7個導出し、各基準について:");
  parts.push("1. 関連するコマンド / テストを**実行**する");
  parts.push("2. 実際の出力を**記録**する");
  parts.push("3. 証拠付きで合否を**判定**する");
  parts.push("");
  parts.push("重要: 必ず実際にコードを実行すること。読むだけで動作を推測しない。");
  parts.push("");
  parts.push("### Step 4: Report");
  parts.push("```");
  parts.push("CRITERIA RESULTS:");
  parts.push("[PASS/FAIL] ruff check — Evidence: ...");
  parts.push("[PASS/FAIL] mypy — Evidence: ...");
  parts.push("[PASS/FAIL] pytest — Evidence: ...");
  parts.push("[PASS/FAIL] coverage ≥ 80% — Evidence: ...");
  parts.push("[PASS/FAIL] <acceptance criterion 1> — Evidence: ...");
  parts.push("OVERALL: X/Y criteria passed");
  parts.push("```");
  parts.push("");
}

function appendTypescriptQaProcess(parts: string[]): void {
  parts.push("## TypeScript QA Process");
  parts.push("");
  parts.push("### Step 1: Mandatory Gates");
  parts.push("Run these FIRST — ANY failure = automatic [QA:FAIL]:");
  parts.push("1. `pnpm lint` (or `npm run lint` / `yarn lint`) — ESLint エラーがないこと");
  parts.push("2. `pnpm exec tsc --noEmit` (or `npx tsc --noEmit`) — 型エラーがないこと");
  parts.push("3. `pnpm test` (or `npm test` / `pnpm exec vitest run`) — 全テスト通過すること");
  parts.push("4. `pnpm build` (or `npm run build`) — ビルドが通ること");
  parts.push("5. 実装された機能/エンドポイントを**実際に実行**してランタイムエラーを確認 — crash/exception があれば即 [QA:FAIL]");
  parts.push("");
  parts.push("上記のいずれかが失敗した場合、即座に [QA:FAIL:<理由>] を出力し、以降のテストは不要。");
  parts.push("");
  parts.push("### Step 2: Coverage Gate");
  parts.push("```bash");
  parts.push("pnpm test -- --coverage");
  parts.push("```");
  parts.push("- 変更されたファイルが未カバーの場合は [QA:FAIL]");
  parts.push("- プロジェクト全体カバレッジ 80% 未満の場合は警告");
  parts.push("");
  parts.push("### Step 3: Acceptance Criteria Verification");
  parts.push("タスク説明から受け入れ基準を3-7個導出し、各基準について:");
  parts.push("1. 関連するコマンド / テストを**実行**する");
  parts.push("2. 実際の出力を**記録**する");
  parts.push("3. 証拠付きで合否を**判定**する");
  parts.push("");
  parts.push("重要: 必ず実際にコードを実行すること。読むだけで動作を推測しない。");
  parts.push("");
  parts.push("### Step 4: Report");
  parts.push("```");
  parts.push("CRITERIA RESULTS:");
  parts.push("[PASS/FAIL] lint — Evidence: ...");
  parts.push("[PASS/FAIL] tsc --noEmit — Evidence: ...");
  parts.push("[PASS/FAIL] tests — Evidence: ...");
  parts.push("[PASS/FAIL] build — Evidence: ...");
  parts.push("[PASS/FAIL] coverage ≥ 80% — Evidence: ...");
  parts.push("[PASS/FAIL] <acceptance criterion 1> — Evidence: ...");
  parts.push("OVERALL: X/Y criteria passed");
  parts.push("```");
  parts.push("");
}

function appendGenericQaProcess(parts: string[]): void {
  parts.push("## QAプロセス");
  parts.push("");
  parts.push("### ステップ1: 受け入れ基準の抽出");
  parts.push("タスク説明（またはスプリント契約がある場合はそれ）から、3-7個の具体的でテスト可能な受け入れ基準を導出。各基準は合否判定できること。");
  parts.push("");

  parts.push("### ステップ2: 必須ビルド/Lintゲート（最初にチェック）");
  parts.push("受け入れ基準の確認前に以下を実行し結果を報告:");
  parts.push("1. `npm run lint`（またはプロジェクトのlintコマンド）— エラーがあれば自動 [QA:FAIL]");
  parts.push("2. `npm run build`（またはプロジェクトのビルドコマンド）— エラーがあれば自動 [QA:FAIL]");
  parts.push("3. TypeScriptの場合 `npx tsc --noEmit` — 型エラーがあれば自動 [QA:FAIL]");
  parts.push("4. アプリ/コードを実行してランタイムエラーを確認 — クラッシュ/例外があれば自動 [QA:FAIL]");
  parts.push("");
  parts.push("上記のいずれかが失敗した場合、即座に [QA:FAIL:<理由>] を出力し、以降のテストは不要。");
  parts.push("");

  parts.push("### ステップ3: 受け入れ基準の検証");
  parts.push("各基準について:");
  parts.push("1. 関連するコマンドを**実行**する");
  parts.push("2. 実際の結果を**記録**する");
  parts.push("3. 証拠付きで合否を**判定**する");
  parts.push("");
  parts.push("重要: 必ず実際にコードを実行すること。読むだけで動作を推測しない。");
  parts.push("");

  parts.push("### ステップ4: レポート");
  parts.push("```");
  parts.push("基準結果:");
  parts.push("[PASS] 基準1 - 証拠: <観察した内容>");
  parts.push("[FAIL] 基準2 - 証拠: <問題の内容>");
  parts.push("総合: X/Y 基準合格");
  parts.push("```");
  parts.push("");
}

export function buildTestGenerationPrompt(
  task: Task,
  projectType: ProjectType = "generic",
  opts?: {
    /**
     * AO Phase 3: when true, the tester is running concurrently with the
     * implementer in the same worktree. Inject a TEST_SCOPE boundary and
     * instruct the agent to emit `[PARALLEL_TEST:DONE] pass|fail` on
     * completion so `stage-pipeline.ts` can skip the now-redundant
     * sequential `test_generation` stage. Defaults to false (historical
     * serial behavior: runs after implementer, no scope restriction).
     */
    parallel?: boolean;
  },
): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  appendSharedContext(parts, task.project_path);

  parts.push("# テスト生成タスク");
  parts.push("");
  parts.push("あなたはテストエンジニアです。このタスクの実装に対するテストを生成してください。");
  parts.push("");

  if (opts?.parallel) {
    parts.push("## TEST_SCOPE（並列モード: テスト担当の作業範囲）");
    parts.push("");
    parts.push(
      "このタスクは **並列 implementer + tester モード** で実行されています。",
    );
    parts.push(
      "別の implementer エージェントが同じ worktree で並行して実装を進めています。",
    );
    parts.push("");
    parts.push("### あなた（tester）の作業範囲");
    parts.push(
      "- **テストファイルのみ** を編集・作成する: `tests/`, `test/`, `spec/`, `__tests__/`, `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`",
    );
    parts.push(
      "- **実装ファイル (src/, lib/, app/, server/, client/) は絶対に編集しない** (do not touch source files)",
    );
    parts.push(
      "- テストから参照する実装が未完成でも構わない — 最新の spec / task description / CLAUDE.md を参考にテストを先に書く",
    );
    parts.push(
      "- 実装側が壊れている場合も自分で直さず、`[IMPL_BREAK] <理由>` とログに書き残して implementer に引き継ぐ",
    );
    parts.push("");
    parts.push("### 衝突回避ルール");
    parts.push(
      "- implementer が触っている実装ファイルを read-only で参照するのは OK、編集は不可",
    );
    parts.push(
      "- 新規ファイルは自分のスコープ（テストディレクトリ）内にのみ作成する",
    );
    parts.push(
      "- コミット粒度は細かく刻み、マージ競合は rebase ではなく追加コミットで解決する",
    );
    parts.push("");
    parts.push("### 完了時の出力（必須）");
    parts.push(
      "作業が終わったら、以下のいずれかのマーカーをログ末尾に必ず出力してください。",
    );
    parts.push(
      "このマーカーを stage-pipeline が検知して serial `test_generation` ステージをスキップします。",
    );
    parts.push("");
    parts.push("- テスト生成・実行すべて成功: `[PARALLEL_TEST:DONE] pass`");
    parts.push(
      "- テスト生成はできたが失敗している / 実装未完成でスキップが必要: `[PARALLEL_TEST:DONE] fail`",
    );
    parts.push("");
    parts.push(
      "マーカーが出力されない場合、pipeline は従来通り serial `test_generation` を追加で実行します（冪等）。",
    );
    parts.push("");
  }

  parts.push("## テスト対象タスク");
  parts.push(`**タイトル**: ${task.title}`);
  parts.push(`**説明**: ${task.description ?? "説明なし"}`);
  parts.push(`**プロジェクトパス**: ${task.project_path ?? "/home/mk/workspace"}`);
  parts.push(`**プロジェクトタイプ**: ${projectType}`);
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
  parts.push("## テスト生成プロセス");
  parts.push("");
  parts.push("1. 実装の変更を読む（git diffまたは変更されたファイルを確認）");
  parts.push("2. テスト可能な動作とエッジケースを特定");
  parts.push("3. 以下をカバーするユニットテストを作成:");
  parts.push("   - 正常系（通常の動作）");
  parts.push("   - エッジケース（境界値、空入力等）");
  parts.push("   - エラーケース（不正な入力、失敗）");
  parts.push("4. テストを実行して通過を確認");
  parts.push("5. 変更コードの80%以上のカバレッジを目指す");
  parts.push("");
  parts.push("## Output");
  parts.push("- Create test files following the project's testing conventions");
  parts.push("- Run all tests and report results");
  parts.push("- If tests fail, fix the tests (not the implementation)");
  parts.push("");
}

export function buildCiCheckPrompt(task: Task): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  appendSharedContext(parts, task.project_path);

  parts.push("# CI/CD Infrastructure Check");
  parts.push("");
  parts.push("You are a DevOps engineer verifying that this project has proper CI/CD infrastructure.");
  parts.push("Your job is NOT to run tests yourself — it is to confirm that automated pipelines exist and are healthy.");
  parts.push("");
  parts.push("## Task Under Review");
  parts.push(`**Title**: ${task.title}`);
  parts.push(`**Description**: ${task.description ?? "No description"}`);
  parts.push(`**Project Path**: ${task.project_path ?? "/home/mk/workspace"}`);
  parts.push("");

  parts.push("## Checklist");
  parts.push("");
  parts.push("### Step 1: CI Workflow Exists");
  parts.push("1. Check `.github/workflows/` for CI workflow file(s)");
  parts.push("2. If missing, create a CI workflow that covers the checks below");
  parts.push("");
  parts.push("### Step 2: CI Covers Required Checks");
  parts.push("The workflow must include ALL of these (or equivalent for the project type):");
  parts.push("- **Lint**: `npm run lint` / `ruff check` / equivalent");
  parts.push("- **Type check**: `npx tsc --noEmit` / `mypy` / equivalent");
  parts.push("- **Unit tests**: `npm test` / `pytest` / equivalent");
  parts.push("- **Build**: `npm run build` / `python -m build` / equivalent");
  parts.push("If any check is missing from the workflow, add it.");
  parts.push("");
  parts.push("### Step 3: CI is Passing");
  parts.push("1. Run `gh run list --branch $(git branch --show-current) --limit 5` to check recent CI runs");
  parts.push("2. If CI has never run on this branch, push and wait for the first run");
  parts.push("3. If CI is red, diagnose and fix the failing step");
  parts.push("");
  parts.push("### Step 4: Package Scripts Exist");
  parts.push("1. `package.json` (or equivalent) must have `test`, `lint`, `build` scripts");
  parts.push("2. If any are missing, add them");
  parts.push("");

  parts.push("## Verdict");
  parts.push("- If ALL checks pass: output `[CI_CHECK:PASS]`");
  parts.push("- If ANY check fails and you CANNOT fix it: output `[CI_CHECK:FAIL:<brief summary>]`");
  parts.push("- If you fixed missing CI/tests/scripts during this run, that counts as PASS");
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
