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
});
