import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_REVIEW_COUNT,
  getMaxReviewCount,
  hasExhaustedReviewBudget,
} from "./review-rules.js";

function createMockDb(settings: Record<string, string>) {
  return {
    prepare: (_sql: string) => ({
      get: (key: string) => {
        const value = settings[key];
        return value === undefined ? undefined : { value };
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("getMaxReviewCount", () => {
  it("returns the default when the setting is missing", () => {
    const db = createMockDb({});
    assert.equal(getMaxReviewCount(db), DEFAULT_MAX_REVIEW_COUNT);
  });

  it("parses the stored string value", () => {
    const db = createMockDb({ review_count: "5" });
    assert.equal(getMaxReviewCount(db), 5);
  });

  it("falls back to the default when the value is not a number", () => {
    const db = createMockDb({ review_count: "not-a-number" });
    assert.equal(getMaxReviewCount(db), DEFAULT_MAX_REVIEW_COUNT);
  });

  it("falls back to the default when the value is negative", () => {
    const db = createMockDb({ review_count: "-1" });
    assert.equal(getMaxReviewCount(db), DEFAULT_MAX_REVIEW_COUNT);
  });

  it("returns 0 when explicitly set to 0 (disables auto review)", () => {
    const db = createMockDb({ review_count: "0" });
    assert.equal(getMaxReviewCount(db), 0);
  });
});

describe("hasExhaustedReviewBudget", () => {
  it("is false when review_count is below the max", () => {
    assert.equal(hasExhaustedReviewBudget({ review_count: 1 }, 3), false);
  });

  it("is true when review_count equals the max", () => {
    assert.equal(hasExhaustedReviewBudget({ review_count: 3 }, 3), true);
  });

  it("is true when review_count exceeds the max", () => {
    assert.equal(hasExhaustedReviewBudget({ review_count: 5 }, 3), true);
  });

  it("is true immediately when max is 0 and review_count is 0", () => {
    // This matches the intent: review_count=0 means "disabled", so the very
    // first check should escalate to human_review without running a review.
    assert.equal(hasExhaustedReviewBudget({ review_count: 0 }, 0), true);
  });
});
