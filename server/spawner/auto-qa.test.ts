import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { triggerAutoQa } from "./auto-qa.js";

function createWsStub() {
  const sent: Array<{ type: string; payload: unknown; options?: unknown }> = [];
  return {
    sent,
    broadcast(type: string, payload: unknown, options?: unknown) {
      sent.push({ type, payload, options });
    },
  };
}

describe("triggerAutoQa", () => {
  it("tags max-iteration escalation logs as human_review", async () => {
    const existingTask = {
      id: "task-qa-max",
      assigned_agent_id: "agent-impl",
      status: "qa_testing",
    };

    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          get: (...args: unknown[]) => {
            calls.push({ sql, args });
            if (sql === "SELECT * FROM tasks WHERE id = ?") return existingTask;
            if (sql.startsWith("SELECT value FROM settings")) {
              if (args[0] === "auto_qa") return { value: "true" };
              if (args[0] === "qa_count") return { value: "2" };
            }
            if (sql.includes("SELECT COUNT(*) AS cnt FROM task_logs")) {
              return { cnt: 2 };
            }
            return undefined;
          },
          all: () => [],
          run: (...args: unknown[]) => {
            calls.push({ sql, args });
            return undefined;
          },
        };
      },
    };
    const ws = createWsStub();

    await triggerAutoQa(db as never, ws as never, existingTask as never);

    const updateCall = calls.find((c) =>
      c.sql.includes("UPDATE tasks SET status = 'human_review'"),
    );
    assert.ok(updateCall, "expected task status to be updated to human_review");

    const logCall = calls.find(
      (c) =>
        c.sql.includes("INSERT INTO task_logs") &&
        c.args.some(
          (a) => typeof a === "string" && a.includes("Auto QA stopped"),
        ),
    );
    assert.ok(logCall, "expected system log explaining the QA escalation");
    assert.equal(logCall.args[2], "human_review");

    const broadcast = ws.sent.find((s) => s.type === "task_update");
    assert.deepEqual(broadcast?.payload, {
      id: "task-qa-max",
      status: "human_review",
    });
  });
});
