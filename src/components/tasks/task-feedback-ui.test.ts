import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTaskFeedbackUi } from "./task-feedback-ui.js";

describe("getTaskFeedbackUi", () => {
  it("returns running-task feedback copy for in_progress", () => {
    assert.deepEqual(getTaskFeedbackUi("in_progress"), {
      detailHeading: "Feedback",
      detailDescription: "Send feedback to the running agent without leaving this task.",
      detailPlaceholder: "Send feedback to the running agent...",
      detailSendLabel: "Send",
    });
  });

  it("returns human review feedback copy with card guidance", () => {
    assert.deepEqual(getTaskFeedbackUi("human_review"), {
      detailHeading: "Feedback",
      detailDescription: "Request changes here before approving or rejecting the review.",
      detailPlaceholder: "Describe the changes you want before sending this task back...",
      detailSendLabel: "Send Feedback",
      cardDescription: "Open detail to request changes before approving or rejecting.",
      cardActionLabel: "Feedback",
    });
  });

  it("returns null for stages without a feedback composer", () => {
    assert.equal(getTaskFeedbackUi("refinement"), null);
    assert.equal(getTaskFeedbackUi("done"), null);
  });
});
