import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildContinuePromptFromInteractiveResponse,
  getInteractivePromptTypeMismatch,
  resolveRequestedAgentId,
} from "./tasks.js";

describe("getInteractivePromptTypeMismatch", () => {
  it("returns null when the pending prompt type matches the request", () => {
    assert.equal(getInteractivePromptTypeMismatch("exit_plan_mode", "exit_plan_mode"), null);
  });

  it("returns the expected pending prompt type when the request mismatches", () => {
    assert.equal(
      getInteractivePromptTypeMismatch("exit_plan_mode", "ask_user_question"),
      "ask_user_question",
    );
  });
});

describe("buildContinuePromptFromInteractiveResponse", () => {
  it("builds an approval message for exit plan mode", () => {
    assert.equal(
      buildContinuePromptFromInteractiveResponse({
        promptType: "exit_plan_mode",
        approved: true,
      }),
      "The user has approved your plan. Proceed with the implementation.",
    );
  });

  it("includes free text answers for ask user question prompts", () => {
    assert.equal(
      buildContinuePromptFromInteractiveResponse({
        promptType: "ask_user_question",
        selectedOptions: { scope: "full" },
        freeText: "Include regression coverage.",
      }),
      "The user has responded to your questions:\n\nQ: scope\nA: full\n\nInclude regression coverage.",
    );
  });
});

describe("resolveRequestedAgentId", () => {
  it("prefers the explicit request agent over the task assignment", () => {
    assert.equal(resolveRequestedAgentId("assigned-agent", "requested-agent"), "requested-agent");
  });

  it("falls back to the task assignment when no request agent is provided", () => {
    assert.equal(resolveRequestedAgentId("assigned-agent", undefined), "assigned-agent");
  });

  it("returns undefined when neither source provides an agent", () => {
    assert.equal(resolveRequestedAgentId(null, undefined), undefined);
  });
});
