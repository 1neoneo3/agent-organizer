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
});
