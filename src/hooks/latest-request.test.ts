import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLatestRequestTracker } from "./latest-request.js";

describe("createLatestRequestTracker", () => {
  it("marks only the newest started request as current", () => {
    const tracker = createLatestRequestTracker();

    const first = tracker.start();
    const second = tracker.start();

    assert.equal(tracker.isCurrent(first), false);
    assert.equal(tracker.isCurrent(second), true);
  });

  it("keeps the latest request current until another request starts", () => {
    const tracker = createLatestRequestTracker();

    const request = tracker.start();

    assert.equal(tracker.isCurrent(request), true);
    assert.equal(tracker.isCurrent(request + 1), false);
  });
});
