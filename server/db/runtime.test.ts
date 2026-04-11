import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const ORIGINAL_DB_PATH = process.env.DB_PATH;

beforeEach(() => {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "ao-db-")), "agent-organizer.db");
});

afterEach(() => {
  if (ORIGINAL_DB_PATH === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = ORIGINAL_DB_PATH;
  }
});

describe("initializeDb", () => {
  it("adds external task columns and seeds the auto dispatch setting", async () => {
    const { initializeDb } = await import("./runtime.js");
    const db = initializeDb();

    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const externalSource = columns.find((column) => column.name === "external_source");
    const externalId = columns.find((column) => column.name === "external_id");
    const reviewBranch = columns.find((column) => column.name === "review_branch");
    const reviewCommitSha = columns.find((column) => column.name === "review_commit_sha");
    const reviewSyncStatus = columns.find((column) => column.name === "review_sync_status");
    const reviewSyncError = columns.find((column) => column.name === "review_sync_error");
    const autoDispatch = db.prepare("SELECT value FROM settings WHERE key = 'auto_dispatch_mode'").get() as
      | { value: string }
      | undefined;

    assert.ok(externalSource);
    assert.ok(externalId);
    assert.ok(reviewBranch);
    assert.ok(reviewCommitSha);
    assert.ok(reviewSyncStatus);
    assert.ok(reviewSyncError);
    assert.equal(autoDispatch?.value, "all_inbox");
  });

  it("adds stage and agent_id columns to task_logs", async () => {
    const { initializeDb } = await import("./runtime.js");
    const db = initializeDb();

    const columns = db.prepare("PRAGMA table_info(task_logs)").all() as Array<{ name: string }>;
    assert.ok(columns.find((c) => c.name === "stage"), "task_logs.stage should exist");
    assert.ok(columns.find((c) => c.name === "agent_id"), "task_logs.agent_id should exist");
  });

  it("adds last_heartbeat_at column to tasks", async () => {
    const { initializeDb } = await import("./runtime.js");
    const db = initializeDb();

    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const heartbeat = columns.find((c) => c.name === "last_heartbeat_at");
    assert.ok(heartbeat, "tasks.last_heartbeat_at should exist");
  });

  it("creates the composite status/priority/created index on tasks", async () => {
    const { initializeDb } = await import("./runtime.js");
    const db = initializeDb();

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'")
      .all() as Array<{ name: string }>;
    const composite = indexes.find((idx) => idx.name === "idx_tasks_status_priority_created");
    assert.ok(composite, "idx_tasks_status_priority_created should exist");

    // Sanity-check the SQLite planner actually picks this index for the
    // periodic dispatch query. If a future refactor renames the index or
    // changes the query shape this test catches the regression.
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE status = 'inbox' ORDER BY priority DESC, created_at ASC",
      )
      .all() as Array<{ detail: string }>;
    const usedComposite = plan.some((row) =>
      row.detail.includes("idx_tasks_status_priority_created"),
    );
    assert.ok(
      usedComposite,
      `planner did not pick the composite index. plan=${JSON.stringify(plan)}`,
    );
  });

  it("auto-populates stage and agent_id on log insert via trigger", async () => {
    const { initializeDb } = await import("./runtime.js");
    const db = initializeDb();

    // Use a unique agent name since DB_PATH is frozen at module load and this
    // db may be shared with other test cases.
    const now = Date.now();
    const agentName = `test-agent-trigger-${now}`;
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("agent-trigger", agentName, "claude", "idle", now, now);
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_agent_id, task_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("task-trigger", "Test Task", "in_progress", "agent-trigger", "small", now, now);

    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'stdout', ?)"
    ).run("task-trigger", "hello");

    const row = db.prepare(
      "SELECT stage, agent_id FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT 1"
    ).get("task-trigger") as { stage: string | null; agent_id: string | null };

    assert.equal(row.stage, "in_progress", "stage should be populated from tasks.status");
    assert.equal(row.agent_id, "agent-trigger", "agent_id should be populated from tasks.assigned_agent_id");
  });

  it("emits a stage transition marker when task status changes", async () => {
    const { initializeDb } = await import("./runtime.js");
    const db = initializeDb();

    const now = Date.now();
    const agentName = `test-agent-transition-${now}`;
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("agent-transition", agentName, "claude", "idle", now, now);
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_agent_id, task_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("task-transition", "Test Task 2", "in_progress", "agent-transition", "small", now, now);

    db.prepare("UPDATE tasks SET status = 'self_review' WHERE id = ?").run("task-transition");

    const marker = db.prepare(
      "SELECT kind, message, stage, agent_id FROM task_logs WHERE task_id = ? AND message LIKE '__STAGE_TRANSITION__:%' ORDER BY id DESC LIMIT 1"
    ).get("task-transition") as { kind: string; message: string; stage: string; agent_id: string } | undefined;

    assert.ok(marker, "stage transition marker should be inserted by trigger");
    assert.equal(marker.kind, "system");
    assert.equal(marker.message, "__STAGE_TRANSITION__:in_progress→self_review");
    assert.equal(marker.stage, "self_review");
    assert.equal(marker.agent_id, "agent-transition");
  });
});
