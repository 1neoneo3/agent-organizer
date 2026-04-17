import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRelativeTaskTime } from "./task-relative-time.js";

describe("formatRelativeTaskTime", () => {
  const now = Date.UTC(2026, 3, 13, 12, 0, 0);

  it("returns just now for newly created tasks", () => {
    assert.equal(formatRelativeTaskTime(now - 15_000, now), "just now");
  });

  it("formats minute-level relative times", () => {
    assert.equal(formatRelativeTaskTime(now - (2 * 60 * 1_000), now), "2m ago");
    assert.equal(formatRelativeTaskTime(now - (59 * 60 * 1_000), now), "59m ago");
  });

  it("formats hour-level relative times at the one hour boundary", () => {
    assert.equal(formatRelativeTaskTime(now - (60 * 60 * 1_000), now), "1h ago");
    assert.equal(formatRelativeTaskTime(now - (23 * 60 * 60 * 1_000), now), "23h ago");
  });

  it("formats day-level relative times once older than a day", () => {
    assert.equal(formatRelativeTaskTime(now - (24 * 60 * 60 * 1_000), now), "1d ago");
    assert.equal(formatRelativeTaskTime(now - (6 * 24 * 60 * 60 * 1_000), now), "6d ago");
  });

  it("clamps future timestamps to just now", () => {
    assert.equal(formatRelativeTaskTime(now + 5_000, now), "just now");
  });

  it("formats week-range diffs with the month bucket (floor-then-clamp)", () => {
    // 7–29 days ago land in the month branch (diff >= WEEK_MS, diff < YEAR_MS)
    // and get clamped to at least 1mo so the label never reads "0mo ago".
    const day = 24 * 60 * 60 * 1_000;
    assert.equal(formatRelativeTaskTime(now - (7 * day), now), "1mo ago");
    assert.equal(formatRelativeTaskTime(now - (29 * day), now), "1mo ago");
  });

  it("formats month-level diffs at and beyond the 30-day boundary", () => {
    const day = 24 * 60 * 60 * 1_000;
    assert.equal(formatRelativeTaskTime(now - (30 * day), now), "1mo ago");
    assert.equal(formatRelativeTaskTime(now - (90 * day), now), "3mo ago");
    assert.equal(formatRelativeTaskTime(now - (364 * day), now), "12mo ago");
  });

  it("formats year-level diffs once the 365-day boundary is crossed", () => {
    const day = 24 * 60 * 60 * 1_000;
    assert.equal(formatRelativeTaskTime(now - (365 * day), now), "1y ago");
    assert.equal(formatRelativeTaskTime(now - (2 * 365 * day), now), "2y ago");
  });
});
