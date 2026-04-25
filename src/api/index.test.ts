import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractApiErrorMessage } from "./index.js";

describe("extractApiErrorMessage", () => {
  it("prefers a top-level message when present", () => {
    const message = extractApiErrorMessage(
      { error: "invalid_feedback", message: "Feedback cannot be empty." },
      400,
      "Bad Request",
    );

    assert.equal(message, "Feedback cannot be empty.");
  });

  it("flattens validation details into a readable message", () => {
    const message = extractApiErrorMessage(
      {
        error: "invalid_feedback",
        details: {
          formErrors: [],
          fieldErrors: {
            content: ["Feedback must be 10,000 characters or fewer."],
          },
        },
      },
      400,
      "Bad Request",
    );

    assert.equal(message, "Feedback must be 10,000 characters or fewer.");
  });

  it("supports legacy flattened objects under error", () => {
    const message = extractApiErrorMessage(
      {
        error: {
          formErrors: [],
          fieldErrors: {
            content: ["Feedback cannot be empty."],
          },
        },
      },
      400,
      "Bad Request",
    );

    assert.equal(message, "Feedback cannot be empty.");
  });

  it("falls back to HTTP status text when the payload is unusable", () => {
    const message = extractApiErrorMessage({ error: { unexpected: true } }, 503, "Service Unavailable");
    assert.equal(message, "HTTP 503 Service Unavailable");
  });
});
