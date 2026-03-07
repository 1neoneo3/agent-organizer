import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectTextInteractivePrompt, parseInteractivePrompt } from "./event-classifier.js";

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

  // --- Boundary ---

  it("does not detect messages shorter than 10 chars", () => {
    const result = detectTextInteractivePrompt("指定して");
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
