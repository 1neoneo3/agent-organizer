import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  triggerAutoHumanReview,
  findHumanReviewAgent,
  countAutoHumanReviewIterations,
} from "./auto-human-reviewer.js";

interface SettingsMap {
  [key: string]: string | undefined;
}

interface FakeAgent {
  id: string;
  name?: string;
  role: string | null;
  status: string;
  agent_type?: string;
  cli_model?: string;
}

interface FakeTask {
  id: string;
  status: string;
  assigned_agent_id: string | null;
}

interface DbStubOptions {
  task: FakeTask | undefined;
  settings: SettingsMap;
  iterationLogCount?: number;
  agents?: FakeAgent[];
}

function createDbStub(options: DbStubOptions) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const inserts: Array<{ sql: string; args: unknown[] }> = [];

  const db = {
    calls,
    inserts,
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          calls.push({ sql, args });
          if (sql.startsWith("SELECT * FROM tasks WHERE id = ?")) {
            return options.task;
          }
          if (sql.startsWith("SELECT value FROM settings")) {
            const key = String(args[0]);
            return options.settings[key] !== undefined
              ? { value: options.settings[key] }
              : undefined;
          }
          if (sql.includes("COUNT(*) AS cnt FROM task_logs")) {
            return { cnt: options.iterationLogCount ?? 0 };
          }
          if (sql.includes("role = 'code_reviewer'")) {
            const excludeId = String(args[0] ?? "");
            return (options.agents ?? []).find(
              (a) =>
                a.role === "code_reviewer" &&
                a.status === "idle" &&
                a.id !== excludeId,
            );
          }
          if (sql.includes("agent_type = 'worker'") && sql.includes("status = 'idle'")) {
            const excludeId = String(args[0] ?? "");
            return (options.agents ?? []).find(
              (a) =>
                a.status === "idle" &&
                (a.agent_type ?? "worker") === "worker" &&
                a.id !== excludeId,
            );
          }
          return undefined;
        },
        all: (...args: unknown[]) => {
          calls.push({ sql, args });
          // resolveStageAgentOverride uses .all for filtered candidate pools.
          if (sql.includes("FROM agents") && sql.includes("WHERE")) {
            return options.agents ?? [];
          }
          return [];
        },
        run: (...args: unknown[]) => {
          inserts.push({ sql, args });
          return undefined;
        },
      };
    },
  };

  return db;
}

function createWsStub() {
  const sent: Array<{ type: string; payload: unknown; options?: unknown }> = [];
  return {
    sent,
    broadcast(type: string, payload: unknown, optionsArg?: unknown) {
      sent.push({ type, payload, options: optionsArg });
    },
  };
}

describe("triggerAutoHumanReview", () => {
  it("returns silently when the task no longer exists", async () => {
    const db = createDbStub({
      task: undefined,
      settings: { auto_human_review: "true" },
    });
    const ws = createWsStub();

    await triggerAutoHumanReview(db as never, ws as never, {
      id: "missing",
      status: "human_review",
      assigned_agent_id: null,
    } as never);

    assert.equal(db.inserts.length, 0);
    assert.equal(ws.sent.length, 0);
  });

  it("skips when status drifted away from human_review", async () => {
    const db = createDbStub({
      task: { id: "t1", status: "in_progress", assigned_agent_id: "impl" },
      settings: { auto_human_review: "true" },
    });
    const ws = createWsStub();

    await triggerAutoHumanReview(db as never, ws as never, {
      id: "t1",
      status: "human_review",
      assigned_agent_id: "impl",
    } as never);

    // No system log inserted since we bail before logging
    assert.equal(db.inserts.length, 0);
  });

  it("skips and logs when auto_human_review is disabled", async () => {
    const db = createDbStub({
      task: { id: "t2", status: "human_review", assigned_agent_id: "impl" },
      settings: { auto_human_review: "false" },
    });
    const ws = createWsStub();

    await triggerAutoHumanReview(db as never, ws as never, {
      id: "t2",
      status: "human_review",
      assigned_agent_id: "impl",
    } as never);

    const skip = db.inserts.find(
      (i) =>
        i.sql.startsWith("INSERT INTO task_logs") &&
        Array.isArray(i.args) &&
        i.args.some(
          (a) =>
            typeof a === "string" &&
            a.includes("Auto Human Review skipped: disabled"),
        ),
    );
    assert.ok(skip, "expected disabled-reason system log");
  });

  it("stops the loop and stays in human_review when iterations reach max", async () => {
    const db = createDbStub({
      task: { id: "t3", status: "human_review", assigned_agent_id: "impl" },
      settings: { auto_human_review: "true", human_review_auto_count: "2" },
      iterationLogCount: 2,
      agents: [
        {
          id: "rev-1",
          name: "Reviewer 1",
          role: "code_reviewer",
          status: "idle",
          agent_type: "worker",
        },
      ],
    });
    const ws = createWsStub();

    await triggerAutoHumanReview(db as never, ws as never, {
      id: "t3",
      status: "human_review",
      assigned_agent_id: "impl",
    } as never);

    // Must NOT insert a panel marker (no new run starts)
    const panelMarker = db.inserts.find(
      (i) =>
        Array.isArray(i.args) &&
        i.args.some(
          (a) => typeof a === "string" && a.startsWith("[REVIEWER_PANEL:"),
        ),
    );
    assert.equal(panelMarker, undefined, "must not start a new run at the cap");

    // Must log the cap hit
    const capLog = db.inserts.find(
      (i) =>
        Array.isArray(i.args) &&
        i.args.some(
          (a) =>
            typeof a === "string" && a.includes("reached max"),
        ),
    );
    assert.ok(capLog, "expected cap-reached system log");

    // Must NOT update task status — we stay in human_review
    const statusUpdate = db.inserts.find((i) =>
      i.sql.includes("UPDATE tasks SET status"),
    );
    assert.equal(
      statusUpdate,
      undefined,
      "must keep the task in human_review when the cap is reached",
    );
  });

  it("skips when no idle reviewer is available", async () => {
    const db = createDbStub({
      task: { id: "t4", status: "human_review", assigned_agent_id: "impl" },
      settings: { auto_human_review: "true" },
      agents: [],
    });
    const ws = createWsStub();

    await triggerAutoHumanReview(db as never, ws as never, {
      id: "t4",
      status: "human_review",
      assigned_agent_id: "impl",
    } as never);

    const skipLog = db.inserts.find(
      (i) =>
        Array.isArray(i.args) &&
        i.args.some(
          (a) => typeof a === "string" && a.includes("no idle review agent"),
        ),
    );
    assert.ok(skipLog, "expected no-reviewer skip log");
  });
});

describe("findHumanReviewAgent", () => {
  it("prefers a code_reviewer role and excludes the implementer", () => {
    const db = createDbStub({
      task: undefined,
      settings: {},
      agents: [
        {
          id: "impl",
          role: "code_reviewer",
          status: "idle",
          agent_type: "worker",
        },
        {
          id: "rev-2",
          role: "code_reviewer",
          status: "idle",
          agent_type: "worker",
        },
      ],
    });

    const picked = findHumanReviewAgent(db as never, "impl");
    assert.equal(picked?.id, "rev-2");
  });

  it("falls back to any idle worker when no code_reviewer is available", () => {
    const db = createDbStub({
      task: undefined,
      settings: {},
      agents: [
        {
          id: "impl",
          role: "lead_engineer",
          status: "idle",
          agent_type: "worker",
        },
        {
          id: "worker",
          role: null,
          status: "idle",
          agent_type: "worker",
        },
      ],
    });

    const picked = findHumanReviewAgent(db as never, "impl");
    assert.equal(picked?.id, "worker");
  });

  it("returns undefined when no idle agents exist (excludes implementer)", () => {
    const db = createDbStub({
      task: undefined,
      settings: {},
      agents: [
        // Only the implementer is idle — must be excluded so we get nothing.
        {
          id: "impl",
          role: "code_reviewer",
          status: "idle",
          agent_type: "worker",
        },
      ],
    });

    const picked = findHumanReviewAgent(db as never, "impl");
    assert.equal(picked, undefined);
  });
});

describe("countAutoHumanReviewIterations", () => {
  it("returns the count from the db iteration log query", () => {
    const db = createDbStub({
      task: undefined,
      settings: {},
      iterationLogCount: 3,
    });

    assert.equal(countAutoHumanReviewIterations(db as never, "any-task"), 3);
  });

  it("returns 0 when no started-log row is found", () => {
    const db = createDbStub({
      task: undefined,
      settings: {},
      // iterationLogCount omitted → defaults to 0 in the stub
    });

    assert.equal(countAutoHumanReviewIterations(db as never, "any-task"), 0);
  });
});

describe("triggerAutoHumanReview — human_review_auto_count edge cases", () => {
  it("falls back to default cap (2) when human_review_auto_count is non-numeric", async () => {
    const db = createDbStub({
      task: { id: "t-bad", status: "human_review", assigned_agent_id: "impl" },
      settings: { auto_human_review: "true", human_review_auto_count: "abc" },
      // Already at 2 iterations — must be capped using the default of 2.
      iterationLogCount: 2,
      agents: [
        {
          id: "rev",
          role: "code_reviewer",
          status: "idle",
          agent_type: "worker",
        },
      ],
    });
    const ws = createWsStub();

    await triggerAutoHumanReview(db as never, ws as never, {
      id: "t-bad",
      status: "human_review",
      assigned_agent_id: "impl",
    } as never);

    const capLog = db.inserts.find(
      (i) =>
        Array.isArray(i.args) &&
        i.args.some(
          (a) => typeof a === "string" && a.includes("reached max (2)"),
        ),
    );
    assert.ok(capLog, "non-numeric setting must fall back to default cap of 2");
  });

  it("clamps human_review_auto_count below 1 up to 1", async () => {
    const db = createDbStub({
      task: { id: "t-neg", status: "human_review", assigned_agent_id: "impl" },
      settings: { auto_human_review: "true", human_review_auto_count: "-1" },
      iterationLogCount: 1,
      agents: [
        {
          id: "rev",
          role: "code_reviewer",
          status: "idle",
          agent_type: "worker",
        },
      ],
    });
    const ws = createWsStub();

    await triggerAutoHumanReview(db as never, ws as never, {
      id: "t-neg",
      status: "human_review",
      assigned_agent_id: "impl",
    } as never);

    const capLog = db.inserts.find(
      (i) =>
        Array.isArray(i.args) &&
        i.args.some(
          (a) => typeof a === "string" && a.includes("reached max (1)"),
        ),
    );
    assert.ok(capLog, "negative setting must clamp to 1");
  });

  it("respects a custom human_review_auto_count when valid", async () => {
    const db = createDbStub({
      task: { id: "t-cap5", status: "human_review", assigned_agent_id: "impl" },
      settings: { auto_human_review: "true", human_review_auto_count: "5" },
      iterationLogCount: 5,
      agents: [
        {
          id: "rev",
          role: "code_reviewer",
          status: "idle",
          agent_type: "worker",
        },
      ],
    });
    const ws = createWsStub();

    await triggerAutoHumanReview(db as never, ws as never, {
      id: "t-cap5",
      status: "human_review",
      assigned_agent_id: "impl",
    } as never);

    const capLog = db.inserts.find(
      (i) =>
        Array.isArray(i.args) &&
        i.args.some(
          (a) => typeof a === "string" && a.includes("reached max (5)"),
        ),
    );
    assert.ok(capLog, "custom cap of 5 must be applied");
  });

  it("clamps human_review_auto_count above 10 down to 10", async () => {
    const db = createDbStub({
      task: { id: "t-cap10", status: "human_review", assigned_agent_id: "impl" },
      settings: { auto_human_review: "true", human_review_auto_count: "999" },
      iterationLogCount: 10,
      agents: [
        {
          id: "rev",
          role: "code_reviewer",
          status: "idle",
          agent_type: "worker",
        },
      ],
    });
    const ws = createWsStub();

    await triggerAutoHumanReview(db as never, ws as never, {
      id: "t-cap10",
      status: "human_review",
      assigned_agent_id: "impl",
    } as never);

    const capLog = db.inserts.find(
      (i) =>
        Array.isArray(i.args) &&
        i.args.some(
          (a) => typeof a === "string" && a.includes("reached max (10)"),
        ),
    );
    assert.ok(capLog, "custom cap must clamp at 10");
  });
});
