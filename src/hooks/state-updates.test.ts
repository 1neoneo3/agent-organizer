import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, Directive, Task } from "../types/index.js";
import { collectReviewTransitions, mergeAgentUpdate, mergeDirectiveUpdate, mergeTaskUpdate } from "./state-updates.js";

function createTask(): Task {
  return {
    id: "task-1",
    title: "Task 1",
    description: null,
    assigned_agent_id: null,
    project_path: null,
    status: "inbox",
    priority: 0,
    task_size: "small",
    task_number: null,
    depends_on: null,
    result: null,
    refinement_plan: null,
    pr_url: null,
    review_count: 0,
    directive_id: null,
    external_source: null,
    external_id: null,
    repository_url: null,
    repository_urls: null,
    pr_urls: null,
    started_at: null,
    completed_at: null,
    auto_respawn_count: 0,
    created_at: 1,
    updated_at: 1,
  };
}

function createAgent(): Agent {
  return {
    id: "agent-1",
    name: "Agent 1",
    cli_provider: "claude",
    cli_model: null,
    cli_reasoning_level: null,
    avatar_emoji: "A",
    role: null,
    agent_type: "worker",
    personality: null,
    status: "idle",
    current_task_id: null,
    stats_tasks_done: 0,
    created_at: 1,
    updated_at: 1,
  };
}

function createDirective(): Directive {
  return {
    id: "directive-1",
    title: "Directive 1",
    content: "content",
    issued_by_type: "user",
    issued_by_id: null,
    status: "pending",
    project_path: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("mergeTaskUpdate", () => {
  it("merges updates into the matching task", () => {
    const result = mergeTaskUpdate([createTask()], { id: "task-1", status: "done" });

    assert.equal(result.found, true);
    assert.equal(result.next[0]?.status, "done");
  });

  it("reports when the task is missing", () => {
    const result = mergeTaskUpdate([createTask()], { id: "missing", status: "done" });

    assert.equal(result.found, false);
    assert.equal(result.next[0]?.id, "task-1");
  });
});

describe("mergeAgentUpdate", () => {
  it("merges updates into the matching agent", () => {
    const result = mergeAgentUpdate([createAgent()], { id: "agent-1", status: "working" });

    assert.equal(result.found, true);
    assert.equal(result.next[0]?.status, "working");
  });
});

describe("mergeDirectiveUpdate", () => {
  it("merges updates into the matching directive", () => {
    const result = mergeDirectiveUpdate([createDirective()], { id: "directive-1", status: "active" });

    assert.equal(result.found, true);
    assert.equal(result.next[0]?.status, "active");
  });
});

describe("collectReviewTransitions", () => {
  it("detects transition into self_review", () => {
    const previous = createTask();
    const next = { ...previous, status: "self_review" as const };

    const transitions = collectReviewTransitions([previous], [next]);

    assert.deepEqual(transitions, [{
      taskId: "task-1",
      title: "Task 1",
      from: "inbox",
      to: "self_review",
    }]);
  });

  it("detects transition from self_review to pr_review", () => {
    const previous = { ...createTask(), status: "self_review" as const };
    const next = { ...previous, status: "pr_review" as const };

    const transitions = collectReviewTransitions([previous], [next]);

    assert.equal(transitions.length, 1);
    assert.equal(transitions[0]?.from, "self_review");
    assert.equal(transitions[0]?.to, "pr_review");
  });

  it("ignores unchanged review status", () => {
    const previous = { ...createTask(), status: "pr_review" as const };
    const next = { ...previous };

    const transitions = collectReviewTransitions([previous], [next]);

    assert.deepEqual(transitions, []);
  });

  it("ignores transitions leaving review", () => {
    const previous = { ...createTask(), status: "pr_review" as const };
    const next = { ...previous, status: "done" as const };

    const transitions = collectReviewTransitions([previous], [next]);

    assert.deepEqual(transitions, []);
  });
});
