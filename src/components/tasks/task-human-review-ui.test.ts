import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getHumanReviewRunUi } from "./task-human-review-ui.js";

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
