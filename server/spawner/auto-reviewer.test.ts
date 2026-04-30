import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { triggerAutoReview, findReviewAgents } from "./auto-reviewer.js";

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
    assert.equal(logCall.args[2], "human_review");

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

/**
 * Build a stub DatabaseSync that only models the three SELECT shapes
 * findReviewAgents issues:
 *   1. code_reviewer lookup
 *   2. security_reviewer lookup (excludes prior picks via NOT IN)
 *   3. fallback worker lookup
 *
 * The caller passes in the idle-agent pool as an array; we dispatch based
 * on the SQL fragment and the args passed to `get(...)` so that exclusion
 * semantics (the NOT IN clause) can be verified without a real sqlite.
 */
function createFindAgentsStub(agents: Array<{
  id: string;
  role: string | null;
  status: string;
  agent_type: string;
}>) {
  return {
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          // 1. code_reviewer lookup
          if (sql.includes("role = 'code_reviewer'")) {
            const excludeId = String(args[0] ?? "");
            return agents.find(
              (a) =>
                a.role === "code_reviewer" &&
                a.status === "idle" &&
                a.id !== excludeId,
            );
          }
          // 2. security_reviewer lookup
          if (sql.includes("role = 'security_reviewer'")) {
            const used = new Set(args.map((a) => String(a ?? "")));
            return agents.find(
              (a) =>
                a.role === "security_reviewer" &&
                a.status === "idle" &&
                !used.has(a.id),
            );
          }
          // 3. fallback worker lookup
          if (sql.includes("agent_type = 'worker'")) {
            const used = new Set(args.map((a) => String(a ?? "")));
            return agents.find(
              (a) =>
                a.status === "idle" &&
                a.agent_type === "worker" &&
                !used.has(a.id),
            );
          }
          return undefined;
        },
      };
    },
  } as unknown as Parameters<typeof findReviewAgents>[0];
}

describe("findReviewAgents", () => {
  it("picks both code_reviewer and security_reviewer when both are idle", () => {
    const db = createFindAgentsStub([
      { id: "agent-code", role: "code_reviewer", status: "idle", agent_type: "worker" },
      { id: "agent-sec", role: "security_reviewer", status: "idle", agent_type: "worker" },
      { id: "agent-impl", role: "lead_engineer", status: "idle", agent_type: "worker" },
    ]);

    const panel = findReviewAgents(db, "agent-impl");

    assert.equal(panel.length, 2, "expected a two-reviewer panel");
    assert.equal(panel[0].role, "code", "primary slot must be the code reviewer");
    assert.equal(panel[0].agent.id, "agent-code");
    assert.equal(panel[1].role, "security");
    assert.equal(panel[1].agent.id, "agent-sec");
  });

  it("excludes the implementer from both slots", () => {
    // The implementer happens to be a code_reviewer — it must not be chosen
    // for either slot, so the only remaining eligible agent fills the code slot.
    const db = createFindAgentsStub([
      { id: "agent-impl", role: "code_reviewer", status: "idle", agent_type: "worker" },
      { id: "agent-code-2", role: "code_reviewer", status: "idle", agent_type: "worker" },
      { id: "agent-sec", role: "security_reviewer", status: "idle", agent_type: "worker" },
    ]);

    const panel = findReviewAgents(db, "agent-impl");

    assert.ok(
      panel.every((p) => p.agent.id !== "agent-impl"),
      "implementer must never appear in the review panel",
    );
    const roles = panel.map((p) => p.role).sort();
    assert.deepEqual(roles, ["code", "security"]);
  });

  it("returns a single-reviewer panel when only code_reviewer is idle", () => {
    const db = createFindAgentsStub([
      { id: "agent-code", role: "code_reviewer", status: "idle", agent_type: "worker" },
      // security_reviewer absent on purpose
      { id: "agent-impl", role: "lead_engineer", status: "idle", agent_type: "worker" },
    ]);

    const panel = findReviewAgents(db, "agent-impl");

    assert.equal(panel.length, 1);
    assert.equal(panel[0].role, "code");
    assert.equal(panel[0].agent.id, "agent-code");
  });

  it("falls back to any idle worker when no code_reviewer role is registered", () => {
    // Simulates a deployment that has only generic worker agents without
    // role assignments. Legacy flow must keep working with a single entry.
    const db = createFindAgentsStub([
      { id: "agent-impl", role: null, status: "idle", agent_type: "worker" },
      { id: "agent-fallback", role: null, status: "idle", agent_type: "worker" },
    ]);

    const panel = findReviewAgents(db, "agent-impl");

    assert.equal(panel.length, 1);
    assert.equal(panel[0].role, "code", "fallback must fill the code slot");
    assert.equal(panel[0].agent.id, "agent-fallback");
  });

  it("returns an empty panel when no eligible reviewer exists", () => {
    const db = createFindAgentsStub([
      // Only the implementer is idle, and they cannot review their own work.
      { id: "agent-impl", role: "code_reviewer", status: "idle", agent_type: "worker" },
    ]);

    const panel = findReviewAgents(db, "agent-impl");

    assert.equal(panel.length, 0);
  });

  it("runs security reviewer alongside fallback worker when no code_reviewer role exists", () => {
    // Edge case: security_reviewer role exists but no code_reviewer. The
    // security reviewer should still be picked up, and the fallback worker
    // takes the primary (code) slot so task state transitions still work.
    const db = createFindAgentsStub([
      { id: "agent-sec", role: "security_reviewer", status: "idle", agent_type: "worker" },
      { id: "agent-fallback", role: null, status: "idle", agent_type: "worker" },
      { id: "agent-impl", role: null, status: "idle", agent_type: "worker" },
    ]);

    const panel = findReviewAgents(db, "agent-impl");

    assert.equal(panel.length, 2);
    assert.equal(panel[0].role, "code", "primary must be code-slot driver");
    assert.equal(panel[0].agent.id, "agent-fallback");
    assert.equal(panel[1].role, "security");
    assert.equal(panel[1].agent.id, "agent-sec");
  });
});

/**
 * Integration tests using a real in-memory SQLite database. These are
 * required to exercise `resolveStageAgentOverride`, which uses
 * `db.prepare(...).all(...)` against the settings + agents tables — the
 * legacy stub above only implements `.get(...)` and would silently
 * bypass the override path. Locking the override behaviour in place
 * here closes the gap that allowed the autoDispatchTask bug
 * (refinement_agent_role ignored at task creation) to ship undetected,
 * and keeps `review_agent_role` / `review_agent_model` from regressing.
 */
describe("findReviewAgents (settings override integration)", () => {
  function createDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_type TEXT NOT NULL DEFAULT 'worker',
        status TEXT NOT NULL DEFAULT 'idle',
        role TEXT,
        cli_model TEXT,
        current_task_id TEXT
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    return db;
  }

  function insertAgent(
    db: DatabaseSync,
    a: {
      id: string;
      role?: string | null;
      cli_model?: string | null;
      status?: string;
      agent_type?: string;
    },
  ): void {
    db.prepare(
      "INSERT INTO agents (id, name, agent_type, status, role, cli_model) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      a.id,
      a.id,
      a.agent_type ?? "worker",
      a.status ?? "idle",
      a.role ?? null,
      a.cli_model ?? null,
    );
  }

  function setSetting(db: DatabaseSync, key: string, value: string): void {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }

  it("uses the role+model override for the primary code slot", () => {
    const db = createDb();
    insertAgent(db, { id: "code-default", role: "code_reviewer", cli_model: "gpt-5.5" });
    insertAgent(db, {
      id: "code-override",
      role: "code_reviewer",
      cli_model: "claude-opus-4-7",
    });
    setSetting(db, "review_agent_role", "code_reviewer");
    setSetting(db, "review_agent_model", "claude-opus-4-7");

    const panel = findReviewAgents(db as never, null);
    const codeSlot = panel.find((a) => a.role === "code");
    assert.equal(codeSlot?.agent.id, "code-override");
  });

  it("excludes the implementer from the override match", () => {
    const db = createDb();
    insertAgent(db, { id: "impl-1", role: "code_reviewer" });
    setSetting(db, "review_agent_role", "code_reviewer");

    const panel = findReviewAgents(db as never, "impl-1");
    // Only the implementer matches the role filter — and it's excluded —
    // so neither override nor role-based fallback should pick anyone.
    assert.equal(panel.length, 0);
  });

  it("falls back to the role-based code_reviewer when no override matches", () => {
    const db = createDb();
    insertAgent(db, { id: "code-1", role: "code_reviewer", cli_model: "gpt-5.5" });
    // Override targets a model nobody runs.
    setSetting(db, "review_agent_role", "code_reviewer");
    setSetting(db, "review_agent_model", "claude-opus-4-7");

    const panel = findReviewAgents(db as never, null);
    const codeSlot = panel.find((a) => a.role === "code");
    assert.equal(codeSlot?.agent.id, "code-1");
  });

  it("override agent does not block the security reviewer secondary slot", () => {
    const db = createDb();
    insertAgent(db, { id: "code-override", role: "code_reviewer", cli_model: "gpt-5.5" });
    insertAgent(db, { id: "sec-1", role: "security_reviewer" });
    setSetting(db, "review_agent_role", "code_reviewer");
    setSetting(db, "review_agent_model", "gpt-5.5");

    const panel = findReviewAgents(db as never, null);
    assert.equal(panel.length, 2);
    assert.equal(panel[0].agent.id, "code-override");
    assert.equal(panel[0].role, "code");
    assert.equal(panel[1].agent.id, "sec-1");
    assert.equal(panel[1].role, "security");
  });
});
