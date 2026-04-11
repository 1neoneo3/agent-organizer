import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildQaPrompt, buildReviewPrompt, buildTaskPrompt } from "./prompt-builder.js";

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
          gitWorkflow: "default",
          workspaceMode: "shared",
          branchPrefix: "ao",
          beforeRun: [],
          afterRun: [],
          includeTask: true,
          includeReview: true,
          includeDecompose: true,
          enableTestGeneration: false,
          enableHumanReview: false,
          enablePreDeploy: false,
          projectType: "generic" as const,
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
        },
      },
    );

    assert.match(prompt, /Localhost listen: blocked/);
    assert.match(prompt, /Delegate E2E to host execution/);
    assert.match(prompt, /pnpm test:e2e/);
    assert.match(prompt, /Keep changes focused/);
  });
});

describe("buildReviewPrompt", () => {
  // Coverage for the regression we saw with verify1-12: reviewers were
  // blindly running `npm run lint` in Python projects, walking up to an
  // unrelated parent repo, and returning NEEDS_CHANGES for infrastructure
  // reasons that had nothing to do with the implementation.
  it("warns the reviewer to ignore verification-metadata sections in the description", () => {
    const prompt = buildReviewPrompt({
      id: "task-1",
      title: "Add charcount CLI",
      description:
        "## 検証対象機能\n**Duration 表示 (commit 22bb153)**\n- タスク詳細に Duration 行が追加された",
      project_path: "/home/mk/workspace",
      repository_url: "https://github.com/acme/charcount-cli",
      task_size: "small",
    } as never);

    assert.match(prompt, /メタ情報だけを理由に `\[REVIEW:NEEDS_CHANGES\]` を出さないこと/);
    assert.match(prompt, /git rev-parse --verify/);
    assert.match(prompt, /が失敗しても、それは欠陥ではありません/);
  });

  it("emits the expected local working directory derived from repository_url", () => {
    const prompt = buildReviewPrompt({
      id: "task-2",
      title: "Demo",
      description: "Short.",
      project_path: "/home/mk/workspace",
      repository_url: "https://github.com/acme/widget-cli",
      task_size: "small",
    } as never);

    assert.match(prompt, /想定ローカル作業ディレクトリ.*\/home\/mk\/workspace\/widget-cli/);
    assert.match(prompt, /cd \/home\/mk\/workspace\/widget-cli/);
  });

  it("includes a project-type-aware build/lint gate table instead of hardcoded npm", () => {
    const prompt = buildReviewPrompt({
      id: "task-3",
      title: "Demo",
      description: "Short.",
      project_path: "/tmp",
      task_size: "small",
    } as never);

    // Python row — check key tokens appear, not the exact line shape
    assert.match(prompt, /`pyproject\.toml`.*Python/);
    assert.match(prompt, /ruff check/);
    // TypeScript row
    assert.match(prompt, /TypeScript/);
    assert.match(prompt, /npm run lint/);
    assert.match(prompt, /npx tsc --noEmit/);
    // Fallback rules: don't punish undefined gates / parent misfires
    assert.match(prompt, /未定義を理由に NEEDS_CHANGES にしない/);
    assert.match(prompt, /親ディレクトリの設定を拾って/);
    assert.match(prompt, /の理由にしない/);
  });
});

describe("buildQaPrompt", () => {
  it("emits Python-specific mandatory gates when projectType is python", () => {
    const prompt = buildQaPrompt(
      {
        id: "task-py",
        title: "Add uuid-gen CLI",
        description: "Python CLI with pytest",
        project_path: "/tmp/py-project",
      } as never,
      "python",
    );

    assert.match(prompt, /## Python QA Process/);
    assert.match(prompt, /### Step 1: Mandatory Gates/);
    assert.match(prompt, /ruff check \./);
    assert.match(prompt, /python -m mypy src/);
    assert.match(prompt, /python -m pytest -q/);
    assert.match(prompt, /ANY failure = automatic \[QA:FAIL\]/);
  });

  it("emits TypeScript-specific mandatory gates when projectType is typescript", () => {
    const prompt = buildQaPrompt(
      {
        id: "task-ts",
        title: "Add button",
        description: "React component with vitest",
        project_path: "/tmp/ts-project",
      } as never,
      "typescript",
    );

    assert.match(prompt, /## TypeScript QA Process/);
    assert.match(prompt, /pnpm lint/);
    assert.match(prompt, /tsc --noEmit/);
    assert.match(prompt, /pnpm build/);
  });

  it("falls back to the generic QA process for generic projects", () => {
    const prompt = buildQaPrompt(
      {
        id: "task-g",
        title: "Demo",
        description: "Short",
        project_path: "/tmp/g",
      } as never,
      "generic",
    );

    assert.match(prompt, /## QAプロセス/);
    assert.doesNotMatch(prompt, /## Python QA Process/);
  });

  it("still emits dbt-specific mandatory gates when projectType is dbt", () => {
    const prompt = buildQaPrompt(
      {
        id: "task-dbt",
        title: "Add mart model",
        description: "New dbt mart model",
        project_path: "/tmp/dbt",
      } as never,
      "dbt",
    );

    assert.match(prompt, /## dbt QA Process/);
    assert.match(prompt, /dbt compile/);
    assert.match(prompt, /dbt test/);
    assert.match(prompt, /dbt build/);
  });
});
