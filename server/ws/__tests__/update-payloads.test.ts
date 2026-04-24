import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickTaskUpdate } from "../update-payloads.js";

describe("pickTaskUpdate", () => {
  it("keeps only the requested keys", () => {
    const payload = pickTaskUpdate(
      {
        id: "task-1",
        title: "Keep title",
        status: "in_progress",
        description: "drop me",
        refinement_plan: "drop me too",
        assigned_agent_id: "agent-1",
      },
      ["title", "status", "assigned_agent_id"],
    );

    assert.deepEqual(payload, {
      id: "task-1",
      title: "Keep title",
      status: "in_progress",
      assigned_agent_id: "agent-1",
    });
  });

  it("omits undefined fields while preserving nulls", () => {
    const payload = pickTaskUpdate(
      {
        id: "task-1",
        completed_at: null,
        started_at: undefined,
        pr_url: null,
      },
      ["started_at", "completed_at", "pr_url"],
    );

    assert.deepEqual(payload, {
      id: "task-1",
      completed_at: null,
      pr_url: null,
    });
  });
});
