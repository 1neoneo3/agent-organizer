import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getRevisionBadge, getPlanBanner } from "./task-card-badges.js";
import { getRefinementRevisionState } from "./task-refinement-state.js";

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

describe("badge and banner consistency (integration)", () => {
  const scenarios: Array<{
    name: string;
    task: {
      refinement_revision_requested_at: number | null;
      refinement_revision_completed_at: number | null;
    };
    hasPlan: boolean;
    expectedState: "not_requested" | "pending" | "completed";
    expectedBadgeLabel: string | null;
    expectedBannerLabel: string | null;
  }> = [
    {
      name: "fresh refinement: no revision, no plan",
      task: { refinement_revision_requested_at: null, refinement_revision_completed_at: null },
      hasPlan: false,
      expectedState: "not_requested",
      expectedBadgeLabel: null,
      expectedBannerLabel: null,
    },
    {
      name: "plan ready, no revision requested",
      task: { refinement_revision_requested_at: null, refinement_revision_completed_at: null },
      hasPlan: true,
      expectedState: "not_requested",
      expectedBadgeLabel: null,
      expectedBannerLabel: "Implementation Plan Ready",
    },
    {
      name: "revision requested, no plan yet",
      task: { refinement_revision_requested_at: 1000, refinement_revision_completed_at: null },
      hasPlan: false,
      expectedState: "pending",
      expectedBadgeLabel: "Revising",
      expectedBannerLabel: "Revision Requested",
    },
    {
      name: "revision requested, old plan still present",
      task: { refinement_revision_requested_at: 1000, refinement_revision_completed_at: null },
      hasPlan: true,
      expectedState: "pending",
      expectedBadgeLabel: "Revising",
      expectedBannerLabel: "Revision Requested",
    },
    {
      name: "revised plan saved",
      task: { refinement_revision_requested_at: 1000, refinement_revision_completed_at: 2000 },
      hasPlan: true,
      expectedState: "completed",
      expectedBadgeLabel: "Revised",
      expectedBannerLabel: "Revised Plan Ready",
    },
    {
      name: "revision completed at exact same timestamp as request",
      task: { refinement_revision_requested_at: 1000, refinement_revision_completed_at: 1000 },
      hasPlan: true,
      expectedState: "completed",
      expectedBadgeLabel: "Revised",
      expectedBannerLabel: "Revised Plan Ready",
    },
    {
      name: "re-requested revision after prior completion",
      task: { refinement_revision_requested_at: 3000, refinement_revision_completed_at: 2000 },
      hasPlan: true,
      expectedState: "pending",
      expectedBadgeLabel: "Revising",
      expectedBannerLabel: "Revision Requested",
    },
  ];

  for (const s of scenarios) {
    it(s.name, () => {
      const state = getRefinementRevisionState(s.task);
      assert.equal(state, s.expectedState);

      const badge = getRevisionBadge("refinement", state);
      assert.equal(badge?.label ?? null, s.expectedBadgeLabel);

      const banner = getPlanBanner("refinement", state, s.hasPlan);
      assert.equal(banner?.label ?? null, s.expectedBannerLabel);
    });
  }
});

describe("non-refinement statuses produce no badge or banner", () => {
  const statuses = ["inbox", "in_progress", "test_generation", "qa_testing", "pr_review", "human_review", "done", "cancelled"];
  const states: Array<"not_requested" | "pending" | "completed"> = ["not_requested", "pending", "completed"];

  for (const status of statuses) {
    for (const state of states) {
      it(`${status} + ${state} → null`, () => {
        assert.equal(getRevisionBadge(status, state), null);
        assert.equal(getPlanBanner(status, state, true), null);
        assert.equal(getPlanBanner(status, state, false), null);
      });
    }
  }
});
