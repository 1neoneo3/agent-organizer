import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskLog } from "../../types/index.js";
import { appendLiveLogs, appendTerminalText, countLogsByTab, MAX_LIVE_LOGS } from "./log-state.js";

function createLog(id: number): TaskLog {
  return {
    id,
    task_id: "task-1",
    kind: "stdout",
    message: `log-${id}`,
    created_at: id,
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

describe("appendTerminalText", () => {
  it("appends stdout and assistant output as plain terminal text", () => {
    const result = appendTerminalText("existing\n", [
      { kind: "stdout", message: "next line" },
      { kind: "assistant", message: "assistant reply" },
    ]);

    assert.equal(result, "existing\nnext line\nassistant reply\n");
  });

  it("prefixes stderr and system messages for terminal display", () => {
    const result = appendTerminalText("", [
      { kind: "stderr", message: "warning" },
      { kind: "system", message: "task paused" },
    ]);

    assert.equal(result, "[stderr] warning\n[system] task paused\n");
  });

  it("skips thinking and tool events in terminal display", () => {
    const result = appendTerminalText("base\n", [
      { kind: "thinking", message: "hidden reasoning" },
      { kind: "tool_call", message: "run shell" },
      { kind: "tool_result", message: "done" },
    ]);

    assert.equal(result, "base\n");
  });
});
