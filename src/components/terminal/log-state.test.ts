import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskLog } from "../../types/index.js";
import {
  appendLiveLogs,
  appendTerminalText,
  countLogsByTab,
  emptySegmentLabel,
  groupLogsByStage,
  inferFetchedBaseCount,
  mergeOlderLogs,
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
    const parsed = parseStageTransition(`${STAGE_TRANSITION_PREFIX}in_progress→pr_review`);
    assert.deepEqual(parsed, { from: "in_progress", to: "pr_review" });
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
        message: `${STAGE_TRANSITION_PREFIX}in_progress→pr_review`,
        stage: "pr_review",
      },
    ]);

    assert.match(result.text, /━━━ STAGE: in_progress → pr_review ━━━/);
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
      { task_id: "task-1", kind: "assistant", message: "second", stage: "pr_review", agent_id: "agent-a" },
    ], { lastStage: step1.lastStage, lastAgentId: step1.lastAgentId });

    assert.match(step2.text, /── \[pr_review\] agent:agent-a ──/);
    assert.equal(step2.lastStage, "pr_review");
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
        stage: "pr_review",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}in_progress→pr_review`,
      }),
      createLog(3, { stage: "pr_review", message: "reviewing" }),
      createLog(4, {
        stage: "qa_testing",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}pr_review→qa_testing`,
      }),
      createLog(5, { stage: "qa_testing", message: "testing" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments.length, 3);
    assert.equal(segments[0]?.stage, "in_progress");
    assert.equal(segments[0]?.fromStage, null);
    assert.match(segments[0]?.text ?? "", /working/);
    assert.equal(segments[1]?.stage, "pr_review");
    assert.equal(segments[1]?.fromStage, "in_progress");
    assert.match(segments[1]?.text ?? "", /reviewing/);
    assert.equal(segments[2]?.stage, "qa_testing");
    assert.equal(segments[2]?.fromStage, "pr_review");
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
      createLog(2, { stage: "pr_review", message: "line-b" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.equal(segments.length, 2);
    assert.equal(segments[0]?.stage, "in_progress");
    assert.equal(segments[1]?.stage, "pr_review");
  });

  it("does not create an implicit segment from hidden post-transition system logs", () => {
    // Regression for #450: after the explicit in_progress→human_review marker,
    // the server may append process-exit / artifact-sync rows with
    // stage=in_progress because they describe the spawn that just completed.
    // Those rows are hidden in Activity, so they must not synthesize a bogus
    // human_review→in_progress segment.
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
      createLog(3, { stage: "in_progress", message: "implementation summary" }),
      createLog(4, {
        stage: "human_review",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}in_progress→human_review`,
      }),
      createLog(5, {
        stage: "in_progress",
        kind: "system",
        message: "Process exited with code 0. Status: human_review",
      }),
      createLog(6, {
        stage: "in_progress",
        kind: "system",
        message: "Review artifact sync: pr_open (https://example.test/pr/1)",
      }),
    ];

    const segments = groupLogsByStage(logs);
    assert.deepEqual(segments.map((segment) => `${segment.fromStage ?? ""}->${segment.stage}`), [
      "inbox->refinement",
      "refinement->in_progress",
      "in_progress->human_review",
    ]);
    assert.equal(segments.at(-1)?.entryCount, 0);
  });

  it("normalizes reverse-chronological logs before grouping refinement revise transitions", () => {
    const logs: TaskLog[] = [
      createLog(5, { stage: "refinement", message: "revising plan" }),
      createLog(4, {
        stage: "refinement",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}inbox→refinement`,
      }),
      createLog(3, {
        stage: "inbox",
        kind: "system",
        message: "[Revise] Refinement plan revision requested. Returning to inbox before re-entering refinement.",
      }),
      createLog(2, {
        stage: "inbox",
        kind: "system",
        message: `${STAGE_TRANSITION_PREFIX}refinement→inbox`,
      }),
      createLog(1, { stage: "refinement", message: "initial plan" }),
    ];

    const segments = groupLogsByStage(logs);
    assert.deepEqual(segments.map((segment) => `${segment.fromStage ?? ""}->${segment.stage}`), [
      "->refinement",
      "refinement->inbox",
      "inbox->refinement",
    ]);
    assert.match(segments[0]?.text ?? "", /initial plan/);
    assert.match(segments[1]?.text ?? "", /Refinement plan revision requested/);
    assert.match(segments[2]?.text ?? "", /revising plan/);
  });

  it("preserves the agent id on the first log of each segment", () => {
    const logs: TaskLog[] = [
      createLog(1, { stage: "in_progress", agent_id: "agent-a", message: "a" }),
      createLog(2, {
        stage: "pr_review",
        kind: "system",
        agent_id: "agent-b",
        message: `${STAGE_TRANSITION_PREFIX}in_progress→pr_review`,
      }),
      createLog(3, { stage: "pr_review", agent_id: "agent-b", message: "b" }),
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

describe("mergeOlderLogs", () => {
  it("prepends older logs and returns chronological order", () => {
    const existing = [createLog(5), createLog(6), createLog(7)];
    const older = [createLog(1), createLog(2), createLog(3)];
    const result = mergeOlderLogs(existing, older);
    assert.deepEqual(result.map((l) => l.id), [1, 2, 3, 5, 6, 7]);
  });

  it("deduplicates by id", () => {
    const existing = [createLog(3), createLog(5), createLog(7)];
    const older = [createLog(1), createLog(3), createLog(5)];
    const result = mergeOlderLogs(existing, older);
    assert.deepEqual(result.map((l) => l.id), [1, 3, 5, 7]);
  });

  it("deduplicates stage transition markers fold-in'd by server", () => {
    const transitionLog = createLog(10, {
      kind: "system",
      message: `${STAGE_TRANSITION_PREFIX}inbox→in_progress`,
      stage: "in_progress",
    });
    const existing = [
      createLog(20, { stage: "in_progress" }),
      createLog(30, { stage: "in_progress" }),
    ];
    const older = [
      createLog(5, { stage: "inbox" }),
      { ...transitionLog },
    ];
    const result = mergeOlderLogs(existing, older);
    assert.deepEqual(result.map((l) => l.id), [5, 10, 20, 30]);
    assert.equal(result.filter((l) => l.id === 10).length, 1);
  });

  it("returns existing array unchanged when older has only duplicates", () => {
    const existing = [createLog(1), createLog(2)];
    const older = [createLog(1), createLog(2)];
    const result = mergeOlderLogs(existing, older);
    assert.strictEqual(result, existing);
  });

  it("returns existing array unchanged when older is empty", () => {
    const existing = [createLog(1)];
    const result = mergeOlderLogs(existing, []);
    assert.strictEqual(result, existing);
  });

  it("sorts by created_at then id for logs with same timestamp", () => {
    const existing = [
      createLog(10, { created_at: 100 }),
      createLog(11, { created_at: 100 }),
    ];
    const older = [
      createLog(2, { created_at: 50 }),
      createLog(3, { created_at: 50 }),
    ];
    const result = mergeOlderLogs(existing, older);
    assert.deepEqual(result.map((l) => l.id), [2, 3, 10, 11]);
  });
});

describe("inferFetchedBaseCount", () => {
  it("caps consumed rows at the requested page size when transition fold-ins expand the page", () => {
    assert.equal(inferFetchedBaseCount(1012, 1000), 1000);
  });

  it("returns the short page length for the final page", () => {
    assert.equal(inferFetchedBaseCount(237, 1000), 237);
  });

  it("returns zero for an empty page", () => {
    assert.equal(inferFetchedBaseCount(0, 1000), 0);
  });
});
