import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getHumanReviewLimitUi, getHumanReviewRunUi } from "./task-human-review-ui.js";

describe("getHumanReviewRunUi", () => {
  it("returns null outside human_review", () => {
    assert.equal(
      getHumanReviewRunUi({ status: "pr_review" }, { name: "Reviewer" }),
      null,
    );
  });

  it("returns null when no agent is actively reviewing", () => {
    assert.equal(getHumanReviewRunUi({ status: "human_review" }, null), null);
  });

  it("returns badge and banner copy while human review is being checked by an agent", () => {
    const ui = getHumanReviewRunUi({ status: "human_review" }, { name: "Reviewer A" });

    assert.deepEqual(ui, {
      badge: {
        label: "Reviewing",
        color: "var(--status-progress)",
        background: "var(--bg-tertiary)",
      },
      banner: {
        label: "Auto Human Review Running",
        color: "var(--status-human-review)",
        description: "Reviewer A is reviewing the completed work.",
      },
    });
  });
});

describe("getHumanReviewLimitUi", () => {
  it("returns null when auto human review has not exhausted its budget", () => {
    assert.equal(getHumanReviewLimitUi({ status: "human_review", human_review_auto_status: "started" }), null);
    assert.equal(getHumanReviewLimitUi({ status: "human_review", human_review_auto_status: null }), null);
  });

  it("returns null after the task has left human_review", () => {
    assert.equal(getHumanReviewLimitUi({ status: "done", human_review_auto_status: "exhausted" }), null);
  });

  it("returns badge and banner copy when the auto human review limit is reached", () => {
    const ui = getHumanReviewLimitUi({ status: "human_review", human_review_auto_status: "exhausted" });

    assert.deepEqual(ui, {
      badge: {
        label: "Maxed",
        color: "var(--status-human-review)",
        background: "var(--bg-tertiary)",
      },
      banner: {
        label: "Auto Human Review Limit Reached",
        color: "var(--status-human-review)",
        description: "Automatic human-review checks reached the configured limit. Review the task manually before approving or rejecting it.",
      },
    });
  });
});
