import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDefaultCliReasoningLevel } from "./agents.js";

describe("resolveDefaultCliReasoningLevel", () => {
  it("defaults codex agents to high reasoning", () => {
    assert.equal(resolveDefaultCliReasoningLevel("codex", undefined), "high");
  });

  it("keeps non-codex agents unset by default", () => {
    assert.equal(resolveDefaultCliReasoningLevel("claude", undefined), null);
    assert.equal(resolveDefaultCliReasoningLevel("gemini", undefined), null);
  });

  it("preserves explicitly provided values", () => {
    assert.equal(resolveDefaultCliReasoningLevel("codex", "medium"), "medium");
    assert.equal(resolveDefaultCliReasoningLevel("codex", null), null);
  });
});
