import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_REQUIRED_MESSAGE,
  FEEDBACK_TOO_LONG_MESSAGE,
  validateFeedbackContent,
} from "./feedback-validation.js";

describe("validateFeedbackContent", () => {
  it("rejects empty input after trimming", () => {
    assert.deepEqual(validateFeedbackContent("   \n\t "), {
      content: "",
      error: FEEDBACK_REQUIRED_MESSAGE,
    });
  });

  it("rejects input longer than FEEDBACK_MAX_LENGTH after trimming", () => {
    const overlong = "x".repeat(FEEDBACK_MAX_LENGTH + 1);
    assert.deepEqual(validateFeedbackContent(overlong), {
      content: overlong,
      error: FEEDBACK_TOO_LONG_MESSAGE,
    });
  });

  it("returns trimmed content when the input is valid", () => {
    assert.deepEqual(validateFeedbackContent("  Tighten the plan.  "), {
      content: "Tighten the plan.",
      error: null,
    });
  });
});
