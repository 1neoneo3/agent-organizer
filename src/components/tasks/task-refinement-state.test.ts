import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getRefinementRevisionState } from "./task-refinement-state.js";

describe("getRefinementRevisionState", () => {
  it("returns not_requested when no revise request exists", () => {
    assert.equal(
      getRefinementRevisionState({
        refinement_revision_requested_at: null,
        refinement_revision_completed_at: null,
      }),
      "not_requested",
    );
  });

  it("returns pending after a revise request until a newer plan is saved", () => {
    assert.equal(
      getRefinementRevisionState({
        refinement_revision_requested_at: 2_000,
        refinement_revision_completed_at: null,
      }),
      "pending",
    );
  });

  it("returns pending when the last saved revision predates the latest request", () => {
    assert.equal(
      getRefinementRevisionState({
        refinement_revision_requested_at: 3_000,
        refinement_revision_completed_at: 2_000,
      }),
      "pending",
    );
  });

  it("returns completed when a revised plan is saved after the latest request", () => {
    assert.equal(
      getRefinementRevisionState({
        refinement_revision_requested_at: 2_000,
        refinement_revision_completed_at: 4_000,
      }),
      "completed",
    );
  });

  it("returns completed when completed_at equals requested_at (same-tick completion)", () => {
    assert.equal(
      getRefinementRevisionState({
        refinement_revision_requested_at: 5_000,
        refinement_revision_completed_at: 5_000,
      }),
      "completed",
    );
  });

  it("returns not_requested when both timestamps are undefined", () => {
    assert.equal(
      getRefinementRevisionState({
        refinement_revision_requested_at: undefined,
        refinement_revision_completed_at: undefined,
      }),
      "not_requested",
    );
  });

  it("returns not_requested when requested_at is null but completed_at has a stale value", () => {
    assert.equal(
      getRefinementRevisionState({
        refinement_revision_requested_at: null,
        refinement_revision_completed_at: 3_000,
      }),
      "not_requested",
    );
  });
});
