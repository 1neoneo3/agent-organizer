import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyEvent,
  detectTextInteractivePrompt,
  isIgnoredEvent,
  parseInteractivePrompt,
} from "./event-classifier.js";

describe("detectTextInteractivePrompt", () => {
  // --- True Positives (should detect) ---

  it("detects Japanese input request: 指定してください", () => {
    const result = detectTextInteractivePrompt("作業ディレクトリを指定してください");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("detects Japanese input request: 教えてください", () => {
    const result = detectTextInteractivePrompt("対象ファイルのパスを教えてください");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("detects Japanese input request: 貼ってください", () => {
    const result = detectTextInteractivePrompt("実行するコマンドをこのスレッドに貼ってください");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("detects Japanese input request: 再指定", () => {
    const result = detectTextInteractivePrompt("対象や完了条件を1行で再指定してください");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("detects Japanese input request: 追加情報", () => {
    const result = detectTextInteractivePrompt("タスクを進めるには追加情報が必要です");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("detects English input request: please provide", () => {
    const result = detectTextInteractivePrompt("Please provide the target directory path for the build output.");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("detects English input request: could you specify", () => {
    const result = detectTextInteractivePrompt("Could you specify which branch to use for deployment?");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("detects English input request: waiting for your input", () => {
    const result = detectTextInteractivePrompt("I'm waiting for your input before proceeding.");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("detects English input request: what would you like", () => {
    const result = detectTextInteractivePrompt("What would you like me to do with the failing tests?");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("detects English input request: please enter the command", () => {
    const result = detectTextInteractivePrompt("Please enter the command you want to run.");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("includes detected text in questions", () => {
    const text = "作業ディレクトリを指定してください";
    const result = detectTextInteractivePrompt(text);
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.questions?.[0]?.question, text);
    assert.strictEqual(result!.detectedText, text);
  });

  // --- True Negatives (should NOT detect) ---

  it("does not detect short messages", () => {
    const result = detectTextInteractivePrompt("OK done.");
    assert.strictEqual(result, null);
  });

  it("does not detect normal assistant text", () => {
    const result = detectTextInteractivePrompt("I've completed the implementation of the feature. The tests are passing.");
    assert.strictEqual(result, null);
  });

  it("does not detect code-like output", () => {
    const result = detectTextInteractivePrompt("The function returns the parsed configuration object with default values applied.");
    assert.strictEqual(result, null);
  });

  it("does not detect tool call descriptions", () => {
    const result = detectTextInteractivePrompt("Tool: Read(/src/index.ts)");
    assert.strictEqual(result, null);
  });

  it("does not detect review summaries that quote user-input examples", () => {
    const result = detectTextInteractivePrompt(`## レビューサマリー

### 変更概要
GH #25 の実装として、agentがテキストベースで追加入力を求めた場合に検出し、UIで返答できる機能を追加。

### 対象にしたいケース
- 実行するコマンドをこのスレッドに貼ってほしい
- 作業ディレクトリを指定してほしい
- 対象ファイルや完了条件を再指定してほしい

### 判定
[REVIEW:PASS]`);
    assert.strictEqual(result, null);
  });

  it("does not detect review summaries as input requests", () => {
    const result = detectTextInteractivePrompt(`実装が完了しました。以下を確認しました。

- 作業ディレクトリを指定してください、のような文言を検出対象に追加
- テストを更新

[REVIEW:PASS]`);
    assert.strictEqual(result, null);
  });

  // --- Boundary ---

  it("does not detect messages shorter than 10 chars", () => {
    const result = detectTextInteractivePrompt("指定して");
    assert.strictEqual(result, null);
  });

  // --- Override: explicit options prompt wins over summary guard ---
  // Regression for task #349: the agent emitted both a [REVIEW:PASS]
  // bullet AND a trailing "次のアクションをどうしますか？" decision
  // list. The summary guard swallowed the prompt and the task stalled
  // in human_review instead of firing input_required.

  it("detects prompt with numbered options even when text contains [REVIEW:PASS]", () => {
    const text = `実装と検証が完了しました。作業内容を報告します。

## 完了状態
- \`server/spawner/auto-reviewer.ts\` を更新
- パネルマーカーに基づく集約
- 全 role PASS 要求 ([REVIEW:PASS])

## 保留事項
- Playwright webServer は sandbox で起動不可のため保留

**次のアクションをどうしますか？**

1. 変更をコミットして push（conventional commit）
2. E2E テストを host 実行で追加
3. このまま停止し、確認のみで終了`;
    const result = detectTextInteractivePrompt(text);
    assert.notStrictEqual(
      result,
      null,
      "should detect prompt despite [REVIEW:PASS] in summary text",
    );
    assert.strictEqual(result!.promptType, "text_input_request");
  });

  it("detects English 'What next?' with numbered options even with review tag", () => {
    const text = `Implementation complete.

[REVIEW:PASS]

What do you want next?
1) Commit and push
2) Add E2E tests
3) Stop here`;
    const result = detectTextInteractivePrompt(text);
    assert.notStrictEqual(result, null);
  });

  it("still ignores a completion summary that has no question-prefixed numbered list", () => {
    // Regression guard: a plain changelog with numbered items should
    // NOT be misclassified. The override only fires when a "?" appears
    // BEFORE the numbered list.
    const text = `実装完了:

1. A file
2. B file

[REVIEW:PASS]`;
    const result = detectTextInteractivePrompt(text);
    assert.strictEqual(result, null);
  });
});

describe("parseInteractivePrompt", () => {
  it("detects ExitPlanMode tool_use", () => {
    const result = parseInteractivePrompt({
      type: "tool_use",
      name: "ExitPlanMode",
      id: "test-id",
      input: {},
    });
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "exit_plan_mode");
    assert.strictEqual(result!.toolUseId, "test-id");
  });

  it("detects AskUserQuestion tool_use", () => {
    const result = parseInteractivePrompt({
      type: "tool_use",
      name: "AskUserQuestion",
      id: "q-id",
      input: {
        questions: [{ question: "What is the target?" }],
      },
    });
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.promptType, "ask_user_question");
    assert.deepStrictEqual(result!.questions, [{ question: "What is the target?" }]);
  });

  it("returns null for non-interactive tool_use", () => {
    const result = parseInteractivePrompt({
      type: "tool_use",
      name: "Read",
      id: "read-id",
      input: { file_path: "/src/index.ts" },
    });
    assert.strictEqual(result, null);
  });

  it("returns null for non-object", () => {
    const result = parseInteractivePrompt({ type: "text", text: "hello" });
    assert.strictEqual(result, null);
  });
});

describe("classifyEvent: codex command_execution", () => {
  it("classifies item.started with command_execution as tool_call", () => {
    const ev = classifyEvent("codex", {
      type: "item.started",
      item: {
        id: "item_2",
        type: "command_execution",
        command: '/bin/bash -lc "rg -n pattern ."',
      },
    });
    assert.notStrictEqual(ev, null);
    assert.ok(!isIgnoredEvent(ev));
    assert.strictEqual(ev!.kind, "tool_call");
    assert.match(ev!.message, /^shell\(/);
    assert.match(ev!.message, /rg/);
  });

  it("classifies item.completed with command_execution as tool_result", () => {
    const ev = classifyEvent("codex", {
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        command: "/bin/bash -lc 'rg -n pattern .'",
        aggregated_output: "./README.md:1:result",
      },
    });
    assert.notStrictEqual(ev, null);
    assert.ok(!isIgnoredEvent(ev));
    assert.strictEqual(ev!.kind, "tool_result");
    assert.match(ev!.message, /^shell\(/);
    assert.match(ev!.message, /→/);
  });

  it("truncates huge aggregated_output to avoid dumping multi-KB into the log", () => {
    const hugeOutput = "x".repeat(200_000);
    const ev = classifyEvent("codex", {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc 'cat huge.txt'",
        aggregated_output: hugeOutput,
      },
    });
    assert.ok(ev);
    assert.ok(!isIgnoredEvent(ev));
    // sanitized output is bounded (sanitizeToolOutput truncates to MAX_TOOL_RESULT_LENGTH = 500)
    assert.ok(
      ev!.message.length < 2000,
      `expected short message, got ${ev!.message.length} bytes`,
    );
  });

  it("drops thread.started as ignored (not raw stdout)", () => {
    const ev = classifyEvent("codex", { type: "thread.started", thread_id: "abc" });
    assert.ok(isIgnoredEvent(ev));
  });

  it("drops turn.started as ignored", () => {
    const ev = classifyEvent("codex", { type: "turn.started" });
    assert.ok(isIgnoredEvent(ev));
  });

  it("still returns null for truly unknown codex event types", () => {
    const ev = classifyEvent("codex", { type: "some.unknown.event", foo: "bar" });
    assert.strictEqual(ev, null);
  });

  it("still classifies codex agent_message normally", () => {
    const ev = classifyEvent("codex", {
      type: "item.completed",
      item: { type: "agent_message", text: "Hello from codex" },
    });
    assert.ok(ev);
    assert.ok(!isIgnoredEvent(ev));
    assert.strictEqual(ev!.kind, "assistant");
    assert.strictEqual(ev!.message, "Hello from codex");
  });
});
