import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import {
  classifyRuntimeFailure,
  computeTransientRetryDelayMs,
  createHookFailureFromCommands,
  handleSpawnFailure,
} from "./spawn-failures.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

function createWs() {
  const events: Array<{ type: string; payload: unknown }> = [];
  return {
    events,
    broadcast(type: string, payload: unknown) {
      events.push({ type, payload });
    },
  };
}

function seedTaskAndAgent(db: DatabaseSync, status = "inbox"): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (id, name, cli_provider, status, current_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("agent-1", "tester", "codex", "working", "task-1", now, now);

  db.prepare(
    `INSERT INTO tasks (
      id, title, status, assigned_agent_id, task_size, created_at, updated_at, started_at
    ) VALUES (?, ?, ?, ?, 'medium', ?, ?, ?)`,
  ).run("task-1", "Hook failure task", status, "agent-1", now, now, now);
}

describe("handleSpawnFailure", () => {
  it("moves a non-retryable before_run failure to human_review", () => {
    const db = createDb();
    seedTaskAndAgent(db);
    const ws = createWs();

    const result = handleSpawnFailure(
      db,
      ws as never,
      "task-1",
      createHookFailureFromCommands(["pnpm install", "pnpm lint"]),
      { source: "Auto dispatch" },
    );

    assert.equal(result.handled, true);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "before_run_failed");

    const task = db.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string };
    assert.equal(task.status, "human_review");

    const agent = db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'agent-1'").get() as {
      status: string;
      current_task_id: string | null;
    };
    assert.equal(agent.status, "idle");
    assert.equal(agent.current_task_id, null);

    const log = db.prepare("SELECT message FROM task_logs WHERE task_id = 'task-1' ORDER BY id DESC LIMIT 1").get() as {
      message: string;
    };
    assert.match(log.message, /Auto dispatch: before_run failed: pnpm install, pnpm lint/);
    assert.match(log.message, /Moved to human_review/);
    assert.ok(ws.events.some((event) => event.type === "task_update"));
  });

  it("leaves generic spawn failures to the caller", () => {
    const db = createDb();
    seedTaskAndAgent(db, "in_progress");
    const ws = createWs();

    const result = handleSpawnFailure(
      db,
      ws as never,
      "task-1",
      new Error("git fetch failed"),
      { source: "Orphan recovery" },
    );

    assert.equal(result.handled, false);
    assert.equal(result.retryable, true);

    const task = db.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string };
    assert.equal(task.status, "in_progress");
  });

});

describe("classifyRuntimeFailure", () => {
  it("classifies 429 as retryable rate limit", () => {
    const failure = classifyRuntimeFailure({
      code: 1,
      signal: null,
      stderr: "HTTP 429 Too Many Requests: rate limit exceeded",
    });

    assert.equal(failure?.code, "runtime_rate_limit");
    assert.equal(failure?.retryable, true);
  });

  it("classifies 529 as retryable overload", () => {
    const failure = classifyRuntimeFailure({
      code: 1,
      signal: null,
      stderr: "Anthropic API returned 529 overloaded_error",
    });

    assert.equal(failure?.code, "runtime_provider_overloaded");
    assert.equal(failure?.retryable, true);
  });

  it("classifies auth expiry as non-retryable", () => {
    const failure = classifyRuntimeFailure({
      code: 1,
      signal: null,
      stderr: "Authentication failed. Please run codex login again.",
    });

    assert.equal(failure?.code, "runtime_auth_expired");
    assert.equal(failure?.retryable, false);
  });

  it("classifies SIGKILL as retryable OOM", () => {
    const failure = classifyRuntimeFailure({
      code: null,
      signal: "SIGKILL",
      stderr: "",
    });

    assert.equal(failure?.code, "runtime_oom");
    assert.equal(failure?.retryable, true);
  });

  it("classifies Playwright MCP startup failure as non-retryable", () => {
    const failure = classifyRuntimeFailure({
      code: 1,
      signal: null,
      stderr: "Playwright MCP failed to start: startup failed after timeout",
    });

    assert.equal(failure?.code, "runtime_playwright_mcp_failed");
    assert.equal(failure?.retryable, false);
  });
});

describe("computeTransientRetryDelayMs", () => {
  it("uses exponential backoff from the base delay", () => {
    assert.equal(computeTransientRetryDelayMs(1), 10_000);
    assert.equal(computeTransientRetryDelayMs(2), 20_000);
    assert.equal(computeTransientRetryDelayMs(3), 40_000);
  });
});
