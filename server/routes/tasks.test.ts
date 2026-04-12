import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  buildContinuePromptFromInteractiveResponse,
  getInteractivePromptTypeMismatch,
} from "./tasks.js";
import { buildValidationErrorResponse } from "./validation-errors.js";

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

describe("buildValidationErrorResponse", () => {
  it("returns descriptive task validation messages", () => {
    const schema = z.object({
      title: z.string().min(1),
      task_size: z.enum(["small", "medium", "large"]),
    });

    const parsed = schema.safeParse({
      title: "",
      task_size: "huge",
    });

    assert.equal(parsed.success, false);
    if (parsed.success) return;

    const response = buildValidationErrorResponse("Task validation", parsed.error);

    assert.equal(response.error, "validation_error");
    assert.equal(
      response.message,
      "Task validation failed: title is required; task_size must be one of: small, medium, large.",
    );
    assert.deepEqual(response.details.fieldErrors, {
      title: ["title is required"],
      task_size: ["task_size must be one of: small, medium, large"],
    });
    assert.deepEqual(response.details.formErrors, []);
  });
});
