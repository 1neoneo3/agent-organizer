import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getRevisionBadge, getPlanBanner } from "./task-card-badges.js";

describe("getRevisionBadge", () => {
  it("returns null for non-refinement status", () => {
    assert.equal(getRevisionBadge("in_progress", "pending"), null);
    assert.equal(getRevisionBadge("inbox", "completed"), null);
    assert.equal(getRevisionBadge("done", "not_requested"), null);
  });

  it("returns null when no revision was requested", () => {
    assert.equal(getRevisionBadge("refinement", "not_requested"), null);
  });

  it('returns "Revising" badge when revision is pending', () => {
    const badge = getRevisionBadge("refinement", "pending");
    assert.notEqual(badge, null);
    assert.equal(badge!.label, "Revising");
    assert.equal(badge!.color, "var(--status-progress)");
  });

  it('returns "Revised" badge when revision is completed', () => {
    const badge = getRevisionBadge("refinement", "completed");
    assert.notEqual(badge, null);
    assert.equal(badge!.label, "Revised");
    assert.equal(badge!.color, "var(--status-done)");
  });
});

describe("getPlanBanner", () => {
  it("returns null for non-refinement status", () => {
    assert.equal(getPlanBanner("in_progress", "not_requested", true), null);
    assert.equal(getPlanBanner("inbox", "pending", false), null);
    assert.equal(getPlanBanner("done", "completed", true), null);
  });

  it('returns "Revision Requested" when revision is pending (regardless of plan)', () => {
    const withPlan = getPlanBanner("refinement", "pending", true);
    const withoutPlan = getPlanBanner("refinement", "pending", false);
    assert.notEqual(withPlan, null);
    assert.equal(withPlan!.label, "Revision Requested");
    assert.equal(withPlan!.color, "var(--status-progress)");
    assert.deepEqual(withPlan, withoutPlan);
  });

  it("returns null when no revision and no plan", () => {
    assert.equal(getPlanBanner("refinement", "not_requested", false), null);
  });

  it('returns "Implementation Plan Ready" when plan exists and no revision requested', () => {
    const banner = getPlanBanner("refinement", "not_requested", true);
    assert.notEqual(banner, null);
    assert.equal(banner!.label, "Implementation Plan Ready");
    assert.equal(banner!.color, "var(--status-refinement)");
  });

  it('returns "Revised Plan Ready" when revision completed and plan exists', () => {
    const banner = getPlanBanner("refinement", "completed", true);
    assert.notEqual(banner, null);
    assert.equal(banner!.label, "Revised Plan Ready");
    assert.equal(banner!.color, "var(--status-done)");
  });

  it("returns null when revision completed but no plan", () => {
    assert.equal(getPlanBanner("refinement", "completed", false), null);
  });
});
