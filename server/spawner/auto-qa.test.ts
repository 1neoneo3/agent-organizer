import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { triggerAutoQa, resolveQaAgent } from "./auto-qa.js";

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

/**
 * In-memory SQLite fixture covering only the columns the QA selector
 * touches. Keeps the unit test independent of the full production
 * schema so we do not need to seed every NOT NULL column on `agents`.
 */
function createSelectorFixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'worker',
      status TEXT NOT NULL DEFAULT 'idle',
      role TEXT,
      cli_model TEXT
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function insertSelectorAgent(
  db: DatabaseSync,
  agent: {
    id: string;
    role?: string | null;
    cli_model?: string | null;
    status?: "idle" | "working" | "offline";
    agent_type?: "worker" | "ceo";
  },
): void {
  db.prepare(
    "INSERT INTO agents (id, name, agent_type, status, role, cli_model) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    agent.id,
    agent.id,
    agent.agent_type ?? "worker",
    agent.status ?? "idle",
    agent.role ?? null,
    agent.cli_model ?? null,
  );
}

function setSelectorSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

describe("resolveQaAgent (selector unit tests)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createSelectorFixture();
  });

  it("returns the override match when qa_agent_role/model is configured and a worker matches", () => {
    insertSelectorAgent(db, { id: "qa-tester", role: "tester", cli_model: "gpt-5.4" });
    insertSelectorAgent(db, { id: "lead-1", role: "lead_engineer" });
    setSelectorSetting(db, "qa_agent_role", "tester");
    setSelectorSetting(db, "qa_agent_model", "gpt-5.4");

    const result = resolveQaAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent?.id, "qa-tester");
    }
  });

  it("strict mode: returns `skip` when override is configured but no idle worker matches", () => {
    insertSelectorAgent(db, { id: "lead-1", role: "lead_engineer" });
    setSelectorSetting(db, "qa_agent_role", "tester");

    const result = resolveQaAgent(db, "implementer-id");
    assert.equal(result.kind, "skip");
    if (result.kind === "skip") {
      assert.match(result.reason, /no matching idle worker/i);
    }
  });

  it("strict mode: returns `skip` when only the implementer would match (excluded)", () => {
    insertSelectorAgent(db, { id: "impl-as-tester", role: "tester" });
    setSelectorSetting(db, "qa_agent_role", "tester");

    const result = resolveQaAgent(db, "impl-as-tester");
    assert.equal(result.kind, "skip");
  });

  it("falls back to a tester role when override is unconfigured", () => {
    insertSelectorAgent(db, { id: "tester-1", role: "tester" });
    insertSelectorAgent(db, { id: "lead-1", role: "lead_engineer" });
    const result = resolveQaAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent?.id, "tester-1");
    }
  });

  it("falls back to any idle worker when neither override nor a tester role is registered", () => {
    insertSelectorAgent(db, { id: "lead-1", role: "lead_engineer" });
    const result = resolveQaAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent?.id, "lead-1");
    }
  });

  it("returns `agent: undefined` (no skip) when unconfigured and no idle worker exists", () => {
    insertSelectorAgent(db, { id: "lead-1", role: "lead_engineer", status: "working" });
    const result = resolveQaAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent, undefined);
    }
  });

  it("treats whitespace-only role/model settings as unconfigured", () => {
    insertSelectorAgent(db, { id: "tester-1", role: "tester" });
    setSelectorSetting(db, "qa_agent_role", "   ");
    setSelectorSetting(db, "qa_agent_model", "   ");
    const result = resolveQaAgent(db, "implementer-id");
    assert.equal(result.kind, "agent");
    if (result.kind === "agent") {
      assert.equal(result.agent?.id, "tester-1");
    }
  });
});
