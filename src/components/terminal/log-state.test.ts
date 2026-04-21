import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskLog } from "../../types/index.js";
import {
  appendLiveLogs,
  appendTerminalText,
  countLogsByTab,
  emptySegmentLabel,
  groupLogsByStage,
  MAX_LIVE_LOGS,
  parseStageTransition,
  STAGE_TRANSITION_PREFIX,
} from "./log-state.js";

function createLog(id: number, overrides: Partial<TaskLog> = {}): TaskLog {
  return {
    id,
    task_id: "task-1",
    kind: "assistant",
    message: `log-${id}`,
    stage: null,
    agent_id: null,
    created_at: id,
    ...overrides,
  };
}

describe("appendLiveLogs", () => {
  it("appends incoming entries in order", () => {
    const result = appendLiveLogs([createLog(1)], [
      { task_id: "task-1", kind: "stdout", message: "next" },
      { task_id: "task-1", kind: "stderr", message: "warn" },
    ], 100);

    assert.equal(result.length, 3);
    assert.equal(result[1]?.message, "next");
    assert.equal(result[2]?.kind, "stderr");
  });

  it("preserves stage and agent metadata on incoming entries", () => {
    const result = appendLiveLogs([], [
      { task_id: "task-1", kind: "stdout", message: "line", stage: "in_progress", agent_id: "agent-a" },
    ], 100);

    assert.equal(result[0]?.stage, "in_progress");
    assert.equal(result[0]?.agent_id, "agent-a");
  });

  it("caps retained entries to the live log limit", () => {
    const seed = Array.from({ length: MAX_LIVE_LOGS }, (_, index) => createLog(index));

    const result = appendLiveLogs(seed, [
      { task_id: "task-1", kind: "stdout", message: "new-entry" },
    ], 1_000);

    assert.equal(result.length, MAX_LIVE_LOGS);
    assert.equal(result[0]?.message, "log-1");
    assert.equal(result.at(-1)?.message, "new-entry");
  });
});

describe("countLogsByTab", () => {
  it("counts all logs as output entries", () => {
    const logs = [createLog(1), createLog(2), createLog(3)];

    assert.deepEqual(countLogsByTab(logs), {
      terminal: 0,
      all: 3,
      output: 3,
    });
  });
});

describe("parseStageTransition", () => {
  it("parses a stage transition marker", () => {
    const parsed = parseStageTransition(`${STAGE_TRANSITION_PREFIX}in_progress→self_review`);
    assert.deepEqual(parsed, { from: "in_progress", to: "self_review" });
  });

  it("returns null for normal messages", () => {
    assert.equal(parseStageTransition("regular log line"), null);
  });
});

describe("appendTerminalText", () => {
  it("keeps assistant output and drops stdout in terminal display", () => {
    const result = appendTerminalText("existing\n", [
      { task_id: "task-1", kind: "stdout", message: "next line" },
      { task_id: "task-1", kind: "assistant", message: "assistant reply" },
    ]);

    assert.equal(result.text, "existing\nassistant reply\n");
    assert.equal(result.lastStage, null);
    assert.equal(result.lastAgentId, null);
  });

  it("drops stderr from terminal display", () => {
    const result = appendTerminalText("", [
      { task_id: "task-1", kind: "stderr", message: "warning" },
    ]);

    assert.equal(result.text, "");
  });

  it("surfaces informative system messages with a marker prefix", () => {
    const result = appendTerminalText("", [
      { task_id: "task-1", kind: "system", message: "task paused" },
    ]);

    assert.match(result.text, /» task paused/);
  });

  it("drops noisy system chatter (process exit, after_run, HANDOFF)", () => {
    const result = appendTerminalText("", [
      { task_id: "task-1", kind: "system", message: "Process exited with code 0. Status: human_review" },
      { task_id: "task-1", kind: "system", message: "[after_run] git status --short: OK" },
      { task_id: "task-1", kind: "system", message: "[HANDOFF] {\"phase\":\"done\"}" },
    ]);

    assert.equal(result.text, "");
  });

  it("skips thinking and tool events in terminal display", () => {
    const result = appendTerminalText("base\n", [
      { task_id: "task-1", kind: "thinking", message: "hidden reasoning" },
      { task_id: "task-1", kind: "tool_call", message: "run shell" },
      { task_id: "task-1", kind: "tool_result", message: "done" },
    ]);

    assert.equal(result.text, "base\n");
  });

  it("renders stage transition markers with a header", () => {
    const result = appendTerminalText("", [
      {
        task_id: "task-1",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}in_progress→self_review`,
        stage: "self_review",
      },
    ]);

    assert.match(result.text, /━━━ STAGE: in_progress → self_review ━━━/);
  });

  it("injects a synthetic header when stage changes between consecutive entries", () => {
    // First batch sets the context (in_progress / agent-a)
    const step1 = appendTerminalText("", [
      { task_id: "task-1", kind: "assistant", message: "first", stage: "in_progress", agent_id: "agent-a" },
    ]);
    assert.equal(step1.lastStage, "in_progress");
    assert.equal(step1.lastAgentId, "agent-a");

    // Second batch has a different stage — expect a header line before the new chunk
    const step2 = appendTerminalText(step1.text, [
      { task_id: "task-1", kind: "assistant", message: "second", stage: "self_review", agent_id: "agent-a" },
    ], { lastStage: step1.lastStage, lastAgentId: step1.lastAgentId });

    assert.match(step2.text, /── \[self_review\] agent:agent-a ──/);
    assert.equal(step2.lastStage, "self_review");
  });

  it("does not inject a header before the very first entry", () => {
    const result = appendTerminalText("", [
      { task_id: "task-1", kind: "assistant", message: "first", stage: "in_progress", agent_id: "agent-a" },
    ]);

    assert.doesNotMatch(result.text, /──/);
    assert.equal(result.text, "first\n");
  });

});

describe("emptySegmentLabel", () => {
  it("returns a human-review-specific message for human_review stage", () => {
    assert.match(emptySegmentLabel("human_review"), /Awaiting human review/);
  });

  it("returns a completion message for done stage", () => {
    assert.match(emptySegmentLabel("done"), /completed/i);
  });

  it("returns the generic placeholder for other stages", () => {
    assert.equal(emptySegmentLabel("in_progress"), "(empty)");
    assert.equal(emptySegmentLabel(null), "(empty)");
  });
});

describe("groupLogsByStage — informative system messages", () => {
  it("surfaces human approval notices in the segment body", () => {
    const logs: TaskLog[] = [
      createLog(1, {
        stage: "human_review",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}in_progress→human_review`,
      }),
      createLog(2, {
        stage: "human_review",
        kind: "system",
        message: "Human review approved. Advancing to done.",
      }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.stage, "human_review");
    assert.match(segments[0]?.text ?? "", /Human review approved/);
    assert.equal(segments[0]?.entryCount, 1);
  });

  it("drops noisy system messages (process exit, after_run, HANDOFF, artifact sync)", () => {
    const logs: TaskLog[] = [
      createLog(1, { stage: "human_review", kind: "system", message: "Process exited with code 0. Status: human_review" }),
      createLog(2, { stage: "human_review", kind: "system", message: "Review artifact sync: not_applicable" }),
      createLog(3, { stage: "human_review", kind: "system", message: "[after_run] git status --short: OK" }),
      createLog(4, { stage: "human_review", kind: "system", message: "[HANDOFF] {\"phase\":\"human_review\"}" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments[0]?.text ?? "", "");
    assert.equal(segments[0]?.entryCount, 0);
  });
});

describe("groupLogsByStage", () => {
  it("returns an empty array for empty input", () => {
    assert.deepEqual(groupLogsByStage([]), []);
  });

  it("groups contiguous logs with the same stage into a single segment", () => {
    const logs: TaskLog[] = [
      createLog(1, { stage: "in_progress", agent_id: "agent-a", message: "a" }),
      createLog(2, { stage: "in_progress", agent_id: "agent-a", message: "b" }),
      createLog(3, { stage: "in_progress", agent_id: "agent-a", message: "c" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.stage, "in_progress");
    assert.equal(segments[0]?.entryCount, 3);
    assert.match(segments[0]?.text ?? "", /a[\s\S]*b[\s\S]*c/);
  });

  it("splits into separate segments on stage transition markers", () => {
    const logs: TaskLog[] = [
      createLog(1, { stage: "in_progress", message: "working" }),
      createLog(2, {
        stage: "self_review",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}in_progress→self_review`,
      }),
      createLog(3, { stage: "self_review", message: "reviewing" }),
      createLog(4, {
        stage: "qa_testing",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}self_review→qa_testing`,
      }),
      createLog(5, { stage: "qa_testing", message: "testing" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments.length, 3);
    assert.equal(segments[0]?.stage, "in_progress");
    assert.equal(segments[0]?.fromStage, null);
    assert.match(segments[0]?.text ?? "", /working/);
    assert.equal(segments[1]?.stage, "self_review");
    assert.equal(segments[1]?.fromStage, "in_progress");
    assert.match(segments[1]?.text ?? "", /reviewing/);
    assert.equal(segments[2]?.stage, "qa_testing");
    assert.equal(segments[2]?.fromStage, "self_review");
    assert.match(segments[2]?.text ?? "", /testing/);
  });

  it("emits a segment for every transition even when a stage produces no displayable logs", () => {
    // Simulates the #412 scenario: inbox→refinement→in_progress→test_generation
    // where refinement produced no assistant logs. Every transition must
    // still result in its own segment so the terminal can show the full
    // stage history.
    const logs: TaskLog[] = [
      createLog(1, {
        stage: "refinement",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}inbox→refinement`,
      }),
      createLog(2, {
        stage: "in_progress",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}refinement→in_progress`,
      }),
      createLog(3, { stage: "in_progress", message: "doing work" }),
      createLog(4, {
        stage: "test_generation",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}in_progress→test_generation`,
      }),
      createLog(5, { stage: "test_generation", message: "writing tests" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments.length, 3);
    // refinement stage had no displayable logs but still gets its own segment.
    assert.equal(segments[0]?.stage, "refinement");
    assert.equal(segments[0]?.fromStage, "inbox");
    assert.equal(segments[0]?.entryCount, 0);
    assert.equal(segments[1]?.stage, "in_progress");
    assert.equal(segments[1]?.fromStage, "refinement");
    assert.match(segments[1]?.text ?? "", /doing work/);
    assert.equal(segments[2]?.stage, "test_generation");
    assert.equal(segments[2]?.fromStage, "in_progress");
    assert.match(segments[2]?.text ?? "", /writing tests/);
  });

  it("merges a transition marker into the current implicit segment when the stage matches", () => {
    // If the client has been streaming logs with stage=in_progress and the
    // (delayed) transition marker then arrives, we must NOT open a second,
    // duplicate in_progress segment. Instead, backfill fromStage on the
    // existing segment and keep it going.
    const logs: TaskLog[] = [
      createLog(1, { stage: "in_progress", message: "already working" }),
      createLog(2, {
        stage: "in_progress",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}refinement→in_progress`,
      }),
      createLog(3, { stage: "in_progress", message: "still working" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.stage, "in_progress");
    assert.equal(segments[0]?.fromStage, "refinement");
    assert.equal(segments[0]?.entryCount, 2);
  });

  it("splits segments when stage changes without an explicit marker", () => {
    const logs: TaskLog[] = [
      createLog(1, { stage: "in_progress", message: "line-a" }),
      createLog(2, { stage: "self_review", message: "line-b" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments.length, 2);
    assert.equal(segments[0]?.stage, "in_progress");
    assert.equal(segments[1]?.stage, "self_review");
  });

  it("preserves the agent id on the first log of each segment", () => {
    const logs: TaskLog[] = [
      createLog(1, { stage: "in_progress", agent_id: "agent-a", message: "a" }),
      createLog(2, {
        stage: "self_review",
        kind: "system",
        agent_id: "agent-b",
        message: `${STAGE_TRANSITION_PREFIX}in_progress→self_review`,
      }),
      createLog(3, { stage: "self_review", agent_id: "agent-b", message: "b" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments.length, 2);
    assert.equal(segments[0]?.agentId, "agent-a");
    assert.equal(segments[1]?.agentId, "agent-b");
  });

  it("drops non-assistant kinds from the grouped segment text", () => {
    // Only assistant messages should survive formatting; stdout / stderr /
    // system are dropped wholesale so raw CLI noise cannot reach the terminal.
    const logs: TaskLog[] = [
      createLog(1, { stage: "in_progress", message: "real assistant reply" }),
      createLog(2, {
        stage: "in_progress",
        kind: "stdout",
        message: "raw cli noise that should be dropped",
      }),
      createLog(3, { stage: "in_progress", message: "another assistant reply" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments.length, 1);
    const text = segments[0]?.text ?? "";
    assert.match(text, /real assistant reply/);
    assert.match(text, /another assistant reply/);
    assert.doesNotMatch(text, /raw cli noise/);
    // Dropped entries must not inflate the counter either.
    assert.equal(segments[0]?.entryCount, 2);
  });
});
