import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { triggerAutoHumanReview, findHumanReviewAgent } from "./auto-human-reviewer.js";

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
      settings: { auto_human_review: "true", human_review_count: "2" },
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
});
