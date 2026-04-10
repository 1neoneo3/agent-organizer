import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { triggerAutoReview } from "./auto-reviewer.js";

function createDbForMissingTask() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];

  return {
    calls,
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          calls.push({ sql, args });
          if (sql === "SELECT * FROM tasks WHERE id = ?") {
            return undefined;
          }
          return undefined;
        },
        run: (...args: unknown[]) => {
          calls.push({ sql, args });
          return undefined;
        },
      };
    },
  };
}

function createWsStub() {
  const sent: Array<{ type: string; payload: unknown; options?: unknown }> = [];
  return {
    sent,
    broadcast(type: string, payload: unknown, options?: unknown) {
      sent.push({ type, payload, options });
    },
  };
}

describe("triggerAutoReview", () => {
  it("returns without side effects when the task no longer exists", async () => {
    const db = createDbForMissingTask();
    const ws = createWsStub();

    await triggerAutoReview(
      db as never,
      ws as never,
      {
        id: "deleted-task",
        assigned_agent_id: null,
        review_count: 0,
      } as never,
    );

    assert.deepEqual(
      db.calls.map((call) => call.sql),
      ["SELECT * FROM tasks WHERE id = ?"],
    );
    assert.equal(ws.sent.length, 0);
  });

  it("promotes task to human_review when review_count reaches max", async () => {
    // Reproduces the bug where a task with review_count >= max would silently
    // stay in pr_review forever, instead of being promoted to human_review.
    const existingTask = {
      id: "task-325",
      assigned_agent_id: "agent-impl",
      status: "pr_review",
      review_count: 2,
    };

    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          get: (...args: unknown[]) => {
            calls.push({ sql, args });
            if (sql === "SELECT * FROM tasks WHERE id = ?") return existingTask;
            if (sql.startsWith("SELECT value FROM settings")) {
              if (args[0] === "auto_review") return { value: "true" };
              if (args[0] === "review_count") return { value: "2" };
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

    await triggerAutoReview(db as never, ws as never, existingTask as never);

    // Must UPDATE status to human_review
    const updateCall = calls.find((c) =>
      c.sql.includes("UPDATE tasks SET status = 'human_review'"),
    );
    assert.ok(
      updateCall,
      "expected task status to be updated to human_review when max reached",
    );

    // Must broadcast the status change
    const broadcast = ws.sent.find((s) => s.type === "task_update");
    assert.ok(broadcast, "expected task_update broadcast");
    assert.deepEqual(broadcast!.payload, {
      id: "task-325",
      status: "human_review",
    });

    // Must log the reason (logSystem binds [taskId, message])
    const logCall = calls.find(
      (c) =>
        c.sql.includes("INSERT INTO task_logs") &&
        Array.isArray(c.args) &&
        c.args.some(
          (a) => typeof a === "string" && a.includes("Moving to human_review"),
        ),
    );
    assert.ok(logCall, "expected system log explaining the promotion");

    // Must NOT have spawned a new review (no increment of review_count)
    const incrementCall = calls.find((c) =>
      c.sql.includes("review_count = review_count + 1"),
    );
    assert.strictEqual(
      incrementCall,
      undefined,
      "must not start another review when max reached",
    );
  });
});
