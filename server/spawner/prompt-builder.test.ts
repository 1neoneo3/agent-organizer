import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDecomposePrompt,
  buildExplorePrompt,
  buildQaPrompt,
  buildRefinementPrompt,
  buildReviewPrompt,
  buildTaskPrompt,
  buildTestGenerationPrompt,
  DEFAULT_OUTPUT_LANGUAGE,
} from "./prompt-builder.js";

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
          enableRefinement: null,
          enableTestGeneration: false,
          enableHumanReview: false,
          enableCiCheck: false,
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

  // --- AO Phase 3: parallel impl/test scope injection ---
  // When the implementer runs concurrently with a parallel tester, the
  // prompt must warn it not to touch test files so the two agents don't
  // clobber each other's work in the shared worktree.
  it("injects IMPL_SCOPE boundary when parallelScope='implementer'", () => {
    const prompt = buildTaskPrompt(
      {
        id: "task-parallel-impl",
        title: "Add feature X",
        description: "Implement the feature.",
        project_path: "/tmp/project",
      } as never,
      { parallelScope: "implementer" },
    );

    // Must clearly identify this as parallel mode and name the boundary.
    assert.match(prompt, /IMPL_SCOPE/);
    assert.match(prompt, /並列/); // "parallel" in Japanese
    // Must forbid the implementer from editing test files.
    assert.match(prompt, /tests?\//);
    assert.match(
      prompt,
      /(テストファイル|test files?).*(編集しない|do not (touch|edit))/i,
    );
  });

  it("does NOT inject IMPL_SCOPE boundary by default (serial mode)", () => {
    const prompt = buildTaskPrompt(
      {
        id: "task-serial",
        title: "Add feature X",
        description: "Implement the feature.",
        project_path: "/tmp/project",
      } as never,
    );

    // Serial mode prompts must stay unchanged — no scope boundary marker.
    assert.doesNotMatch(prompt, /IMPL_SCOPE/);
  });

  // The earlier IMPL_SCOPE test only checks for a generic "tests/" token.
  // That's not strict enough: in practice our repos have test files that
  // live OUTSIDE `tests/` (e.g. `foo.test.ts` next to `foo.ts`, or
  // `__tests__/` directories in React code). The implementer prompt must
  // enumerate those glob patterns by name so the agent can't "sneak" an
  // edit into a colocated `.test.ts` file and collide with the parallel
  // tester. Lock the exact patterns into the test so a prompt rewrite
  // can't silently drop them.
  it("IMPL_SCOPE enumerates colocated test patterns (*.test.*, *.spec.*, __tests__/)", () => {
    const prompt = buildTaskPrompt(
      {
        id: "task-scope-patterns",
        title: "Add feature X",
        description: "Implement the feature.",
        project_path: "/tmp/project",
      } as never,
      { parallelScope: "implementer" },
    );

    assert.match(prompt, /\*\.test\.\*/);
    assert.match(prompt, /\*\.spec\.\*/);
    assert.match(prompt, /__tests__/);
    // Python-style test files too, since parallel mode is language-agnostic.
    assert.match(prompt, /test_\*\.py/);
  });
});

describe("buildTestGenerationPrompt", () => {
  // Parallel tester is spawned while the implementer is still writing code.
  // The prompt must warn the tester not to touch source files so its edits
  // can't collide with the implementer's work in the shared worktree.
  it("injects TEST_SCOPE boundary when parallel=true", () => {
    const prompt = buildTestGenerationPrompt(
      {
        id: "task-parallel-tester",
        title: "Add feature X",
        description: "Write tests for feature X.",
        project_path: "/tmp/project",
      } as never,
      "generic",
      { parallel: true },
    );

    assert.match(prompt, /TEST_SCOPE/);
    assert.match(prompt, /並列/);
    // Tester must not edit implementation/source trees.
    assert.match(
      prompt,
      /(src\/|lib\/|app\/|実装ファイル|source files?)/i,
    );
    assert.match(
      prompt,
      /(編集しない|do not (touch|edit))/i,
    );
    // Must emit the completion marker so stage-pipeline can skip
    // test_generation later.
    assert.match(prompt, /PARALLEL_TEST:DONE/);
  });

  it("does NOT inject TEST_SCOPE boundary by default (serial test_generation stage)", () => {
    const prompt = buildTestGenerationPrompt(
      {
        id: "task-serial-testgen",
        title: "Add feature X",
        description: "Write tests.",
        project_path: "/tmp/project",
      } as never,
    );

    assert.doesNotMatch(prompt, /TEST_SCOPE/);
    assert.doesNotMatch(prompt, /PARALLEL_TEST:DONE/);
  });

  // The earlier TEST_SCOPE test only checks `src/|lib/|app/`. In practice
  // the worst collision targets in this repo are `server/` and `client/`
  // (multi-package layouts), so spell those out too. Without them, the
  // tester could silently patch `server/workflow/*.ts` while the
  // implementer is editing the same file, corrupting the worktree.
  it("TEST_SCOPE forbids editing server/ and client/ trees in multi-package layouts", () => {
    const prompt = buildTestGenerationPrompt(
      {
        id: "task-multi-pkg",
        title: "Add feature X",
        description: "Write tests for feature X.",
        project_path: "/tmp/project",
      } as never,
      "generic",
      { parallel: true },
    );

    assert.match(prompt, /server\//);
    assert.match(prompt, /client\//);
  });

  // The parallel tester emits one of two verdict markers so the pipeline
  // can distinguish "tests generated and passing" from "tests generated
  // but failing". Both variants must be documented in the prompt or the
  // agent will guess a format that stage-pipeline's LIKE matcher won't
  // recognize, and the serial fallback stage will re-run needlessly.
  it("TEST_SCOPE documents BOTH [PARALLEL_TEST:DONE] pass and fail completion markers", () => {
    const prompt = buildTestGenerationPrompt(
      {
        id: "task-verdicts",
        title: "Add feature X",
        description: "Write tests.",
        project_path: "/tmp/project",
      } as never,
      "generic",
      { parallel: true },
    );

    assert.match(prompt, /\[PARALLEL_TEST:DONE\]\s+pass/);
    assert.match(prompt, /\[PARALLEL_TEST:DONE\]\s+fail/);
  });
});

describe("buildRefinementPrompt", () => {
  it("keeps refinement read-only by default", () => {
    const prompt = buildRefinementPrompt({
      id: "task-refinement-default",
      title: "Plan the work",
      description: "Draft a refinement plan.",
      project_path: "/tmp/project",
      status: "refinement",
    } as never);

    assert.match(prompt, /コードの変更は行わないでください。分析と計画策定のみ。/);
    assert.match(prompt, /ファイルの作成・編集・書き込みをしないこと。/);
  });

  it("allows plan-file creation when refinement_as_pr is enabled", () => {
    const prompt = buildRefinementPrompt(
      {
        id: "task-refinement-pr",
        title: "Plan the work",
        description: "Draft a refinement plan.",
        project_path: "/tmp/project",
        status: "refinement",
      } as never,
      undefined,
      { asPr: true },
    );

    assert.match(prompt, /計画書の作成・保存・PR 化のみ許可されます/);
    assert.match(prompt, /計画書 Markdown の作成・更新、git 操作、PR 作成のみ許可されます/);
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

  // Scope creep detection — reviewers must flag unrelated changes and send
  // the task back to in_progress so the implementer can strip them.
  it("includes a scope-creep checklist item that forces NEEDS_CHANGES on unrelated changes", () => {
    const prompt = buildReviewPrompt({
      id: "task-scope",
      title: "Demo",
      description: "Short.",
      project_path: "/tmp",
      task_size: "small",
    } as never);

    assert.match(prompt, /変更範囲.*無関係な変更/);
    assert.match(prompt, /scope_creep/);
    assert.match(prompt, /Scope:\s+\[X\/5\]/);
    assert.match(prompt, /Scope が 1-2.*必ず NEEDS_CHANGES/);
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

// ---------------------------------------------------------------------------
// Output-language switching — every builder must honor the language flag by
// emitting the correct "## Language" directive. The directive drives the
// agent's response language; control tokens (SPRINT CONTRACT, ---REFINEMENT
// PLAN---, [REVIEW:<role>:PASS], ---EXPLORE RESULT---) must stay stable
// across languages so downstream parsers keep working.
// ---------------------------------------------------------------------------
describe("output language directive", () => {
  const task = {
    id: "lang-task",
    title: "Switch language",
    description: "Ensure language handling works.",
    project_path: "/tmp/lang",
    task_size: "small",
  } as never;

  it("buildTaskPrompt emits Japanese directive by default", () => {
    const prompt = buildTaskPrompt(task);
    assert.match(prompt, /Always respond and communicate in Japanese/);
  });

  it("buildTaskPrompt emits English directive when language='en'", () => {
    const prompt = buildTaskPrompt(task, { language: "en" });
    assert.match(prompt, /Always respond and communicate in English/);
    assert.doesNotMatch(prompt, /Always respond and communicate in Japanese/);
    // Control tokens must remain stable.
    assert.match(prompt, /---SPRINT CONTRACT---/);
    assert.match(prompt, /---END CONTRACT---/);
  });

  it("buildRefinementPrompt emits English section headers when language='en'", () => {
    const prompt = buildRefinementPrompt(task, undefined, { language: "en" });
    assert.match(prompt, /Always respond and communicate in English/);
    assert.match(prompt, /## Background/);
    assert.match(prompt, /## Business Requirements/);
    assert.match(prompt, /## Acceptance Criteria/);
    assert.match(prompt, /## Implementation Plan/);
    assert.match(prompt, /## Updated Description/);
    // Fence tokens are parser-critical — must be unchanged.
    assert.match(prompt, /---REFINEMENT PLAN---/);
    assert.match(prompt, /---END REFINEMENT---/);
  });

  it("buildRefinementPrompt emits Japanese section headers by default", () => {
    const prompt = buildRefinementPrompt(task);
    assert.match(prompt, /## 背景/);
    assert.match(prompt, /## 実装計画/);
    assert.match(prompt, /## 更新されたタスク説明/);
    assert.match(prompt, /---REFINEMENT PLAN---/);
    assert.match(prompt, /---END REFINEMENT---/);
  });

  it("buildExplorePrompt emits English body when language='en' while keeping EXPLORE fences", () => {
    const prompt = buildExplorePrompt(task, "en");
    assert.match(prompt, /# Explore Phase: Investigation Only/);
    assert.match(prompt, /---EXPLORE RESULT---/);
    assert.match(prompt, /---END EXPLORE---/);
  });

  it("buildQaPrompt / buildReviewPrompt / buildTestGenerationPrompt honor the language flag", () => {
    const qa = buildQaPrompt(task, "generic", "en");
    assert.match(qa, /Always respond and communicate in English/);

    const review = buildReviewPrompt(task, { language: "en" });
    assert.match(review, /Always respond and communicate in English/);
    // Verdict control tokens are language-agnostic.
    assert.match(review, /\[REVIEW:code:PASS\]/);

    const testGen = buildTestGenerationPrompt(task, "generic", { language: "en" });
    assert.match(testGen, /Always respond and communicate in English/);
  });
});

describe("DEFAULT_OUTPUT_LANGUAGE", () => {
  it("is 'ja' (preserving historical default)", () => {
    assert.equal(DEFAULT_OUTPUT_LANGUAGE, "ja");
  });
});

describe("language directive completeness", () => {
  const task = {
    id: "lang-complete",
    title: "Completeness check",
    description: "Verify all builders emit exactly one language directive.",
    project_path: "/tmp/lang",
    task_size: "small",
  } as never;

  it("buildTaskPrompt never includes both language directives simultaneously", () => {
    const jaPrompt = buildTaskPrompt(task);
    assert.match(jaPrompt, /Always respond and communicate in Japanese/);
    assert.doesNotMatch(jaPrompt, /Always respond and communicate in English/);

    const enPrompt = buildTaskPrompt(task, { language: "en" });
    assert.match(enPrompt, /Always respond and communicate in English/);
    assert.doesNotMatch(enPrompt, /Always respond and communicate in Japanese/);
  });

  it("buildRefinementPrompt never includes both language directives simultaneously", () => {
    const jaPrompt = buildRefinementPrompt(task);
    assert.match(jaPrompt, /Always respond and communicate in Japanese/);
    assert.doesNotMatch(jaPrompt, /Always respond and communicate in English/);

    const enPrompt = buildRefinementPrompt(task, undefined, { language: "en" });
    assert.match(enPrompt, /Always respond and communicate in English/);
    assert.doesNotMatch(enPrompt, /Always respond and communicate in Japanese/);
  });

  it("buildExplorePrompt never includes both language directives simultaneously", () => {
    const jaPrompt = buildExplorePrompt(task);
    assert.match(jaPrompt, /Always respond and communicate in Japanese/);
    assert.doesNotMatch(jaPrompt, /Always respond and communicate in English/);

    const enPrompt = buildExplorePrompt(task, "en");
    assert.match(enPrompt, /Always respond and communicate in English/);
    assert.doesNotMatch(enPrompt, /Always respond and communicate in Japanese/);
  });

  it("buildQaPrompt never includes both language directives simultaneously", () => {
    const jaPrompt = buildQaPrompt(task, "generic");
    assert.match(jaPrompt, /Always respond and communicate in Japanese/);
    assert.doesNotMatch(jaPrompt, /Always respond and communicate in English/);

    const enPrompt = buildQaPrompt(task, "generic", "en");
    assert.match(enPrompt, /Always respond and communicate in English/);
    assert.doesNotMatch(enPrompt, /Always respond and communicate in Japanese/);
  });

  it("buildReviewPrompt never includes both language directives simultaneously", () => {
    const jaPrompt = buildReviewPrompt(task);
    assert.match(jaPrompt, /Always respond and communicate in Japanese/);
    assert.doesNotMatch(jaPrompt, /Always respond and communicate in English/);

    const enPrompt = buildReviewPrompt(task, { language: "en" });
    assert.match(enPrompt, /Always respond and communicate in English/);
    assert.doesNotMatch(enPrompt, /Always respond and communicate in Japanese/);
  });

  it("buildTestGenerationPrompt never includes both language directives simultaneously", () => {
    const jaPrompt = buildTestGenerationPrompt(task, "generic");
    assert.match(jaPrompt, /Always respond and communicate in Japanese/);
    assert.doesNotMatch(jaPrompt, /Always respond and communicate in English/);

    const enPrompt = buildTestGenerationPrompt(task, "generic", { language: "en" });
    assert.match(enPrompt, /Always respond and communicate in English/);
    assert.doesNotMatch(enPrompt, /Always respond and communicate in Japanese/);
  });
});

describe("control tokens remain stable across languages", () => {
  const task = {
    id: "token-stability",
    title: "Token stability",
    description: "Ensure control tokens are language-independent.",
    project_path: "/tmp/tokens",
    task_size: "small",
  } as never;

  it("buildTaskPrompt preserves SPRINT CONTRACT tokens in both languages", () => {
    const ja = buildTaskPrompt(task);
    const en = buildTaskPrompt(task, { language: "en" });

    for (const prompt of [ja, en]) {
      assert.match(prompt, /---SPRINT CONTRACT---/);
      assert.match(prompt, /---END CONTRACT---/);
    }
  });

  it("buildRefinementPrompt preserves REFINEMENT fence tokens in both languages", () => {
    const ja = buildRefinementPrompt(task);
    const en = buildRefinementPrompt(task, undefined, { language: "en" });

    for (const prompt of [ja, en]) {
      assert.match(prompt, /---REFINEMENT PLAN---/);
      assert.match(prompt, /---END REFINEMENT---/);
    }
  });

  it("buildExplorePrompt preserves EXPLORE fence tokens in both languages", () => {
    const ja = buildExplorePrompt(task);
    const en = buildExplorePrompt(task, "en");

    for (const prompt of [ja, en]) {
      assert.match(prompt, /---EXPLORE RESULT---/);
      assert.match(prompt, /---END EXPLORE---/);
    }
  });

  it("buildReviewPrompt preserves REVIEW verdict tokens in both languages", () => {
    const ja = buildReviewPrompt(task);
    const en = buildReviewPrompt(task, { language: "en" });

    for (const prompt of [ja, en]) {
      assert.match(prompt, /\[REVIEW:code:PASS\]/);
    }
  });
});

describe("buildRefinementPrompt English section headers completeness", () => {
  const task = {
    id: "refinement-en-headers",
    title: "Headers test",
    description: "Test all section headers switch.",
    project_path: "/tmp/headers",
    task_size: "medium",
  } as never;

  it("English mode emits all required English headers", () => {
    const prompt = buildRefinementPrompt(task, undefined, { language: "en" });

    assert.match(prompt, /## Background/);
    assert.match(prompt, /## Business Requirements/);
    assert.match(prompt, /## Acceptance Criteria/);
    assert.match(prompt, /## Implementation Plan/);
    assert.match(prompt, /## Updated Description/);
  });

  it("Japanese mode emits all required Japanese headers", () => {
    const prompt = buildRefinementPrompt(task);

    assert.match(prompt, /## 背景/);
    assert.match(prompt, /## 実装計画/);
    assert.match(prompt, /## 更新されたタスク説明/);
  });
});

describe("buildExplorePrompt English mode", () => {
  const task = {
    id: "explore-en",
    title: "Explore EN",
    description: "Test explore English mode.",
    project_path: "/tmp/explore",
  } as never;

  it("emits English investigation header", () => {
    const prompt = buildExplorePrompt(task, "en");
    assert.match(prompt, /# Explore Phase: Investigation Only/);
  });

  it("emits Japanese investigation header by default", () => {
    const prompt = buildExplorePrompt(task);
    assert.match(prompt, /調査/);
  });
});

describe("buildDecomposePrompt language switching", () => {
  const directive = {
    id: "directive-lang",
    title: "Language-aware task generation",
    content: "Create decomposed tasks and plan output in the selected language.",
    project_path: "/tmp/directive-lang",
  } as never;

  it("emits English decomposition instructions when language='en'", () => {
    const prompt = buildDecomposePrompt(directive, "en");

    assert.match(prompt, /Always respond and communicate in English/);
    assert.match(prompt, /# Directive: Language-aware task generation/);
    assert.match(prompt, /## Instructions/);
    assert.match(prompt, /Break this directive into 2-8 concrete tasks/);
    assert.match(prompt, /# Implementation Plan: \{directive title\}/);
    assert.match(prompt, /---PLAN---/);
    assert.doesNotMatch(prompt, /## 指示/);
    assert.doesNotMatch(prompt, /この指示を2-8個の具体的なタスクに分解/);
  });

  it("emits Japanese decomposition instructions by default", () => {
    const prompt = buildDecomposePrompt(directive);

    assert.match(prompt, /Always respond and communicate in Japanese/);
    assert.match(prompt, /# 指示: Language-aware task generation/);
    assert.match(prompt, /## 指示/);
    assert.match(prompt, /この指示を2-8個の具体的なタスクに分解/);
    assert.match(prompt, /# 実装計画: \{directive title\}/);
    assert.match(prompt, /---PLAN---/);
    assert.doesNotMatch(prompt, /## Instructions/);
  });
});
