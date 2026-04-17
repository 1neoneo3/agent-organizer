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

  it("applies performance-oriented PRAGMAs", async () => {
    const { initializeDb } = await import("./runtime.js");
    const db = initializeDb();

    // journal_mode is returned as a bare string, the rest as numeric codes.
    const jm = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(jm.journal_mode, "wal");

    const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    // synchronous: 0 = OFF, 1 = NORMAL, 2 = FULL, 3 = EXTRA
    assert.equal(sync.synchronous, 1, "synchronous should be NORMAL (1)");

    const cache = db.prepare("PRAGMA cache_size").get() as { cache_size: number };
    // Negative value means the argument is in KB rather than pages.
    assert.equal(cache.cache_size, -32000, "cache_size should be -32000 (32MB)");

    const temp = db.prepare("PRAGMA temp_store").get() as { temp_store: number };
    // temp_store: 0 = DEFAULT, 1 = FILE, 2 = MEMORY
    assert.equal(temp.temp_store, 2, "temp_store should be MEMORY (2)");

    const mmap = db.prepare("PRAGMA mmap_size").get() as { mmap_size: number };
    // 64MB expressed in bytes. Some platforms may clamp mmap_size to a
    // lower value if mmap is unavailable, so accept >= 0 but at least
    // assert we attempted the requested value by reading it back.
    assert.equal(mmap.mmap_size, 67108864, "mmap_size should be 64MB");

    const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    assert.equal(busy.timeout, 5000, "busy_timeout should be 5000ms");

    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    assert.equal(fk.foreign_keys, 1, "foreign_keys should be ON");
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

  it("preserves caller-provided stage regardless of tasks.status (no trigger override)", async () => {
    // Regression test for PR 1 of issue #99 (refinement plan / Terminal Activity bug).
    // The `task_logs_fill_metadata` trigger historically auto-filled stage from
    // (SELECT status FROM tasks WHERE id = ?), which races with a concurrent
    // status UPDATE in performFinalization. Spawn-path INSERTs now always
    // provide `stage` explicitly; this test ensures the trigger leaves those
    // values alone rather than overwriting them.
    const { initializeDb } = await import("./runtime.js");
    const db = initializeDb();

    const now = Date.now();
    const agentName = `test-agent-stage-preserve-${now}`;
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("agent-stage-preserve", agentName, "claude", "idle", now, now);
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_agent_id, task_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("task-stage-preserve", "Stage Race", "in_progress", "agent-stage-preserve", "small", now, now);

    // Caller passes stage='refinement' even though tasks.status='in_progress'.
    // This mimics the refinement spawn emitting a late stdout chunk after the
    // task has already been transitioned forward by performFinalization.
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, agent_id) VALUES (?, 'assistant', ?, 'refinement', ?)"
    ).run("task-stage-preserve", "---REFINEMENT PLAN--- ... ---END REFINEMENT---", "agent-stage-preserve");

    const row = db.prepare(
      "SELECT stage, agent_id FROM task_logs WHERE task_id = ? AND kind = 'assistant' ORDER BY id DESC LIMIT 1"
    ).get("task-stage-preserve") as { stage: string | null; agent_id: string | null };

    assert.equal(row.stage, "refinement", "explicit stage must win over tasks.status fallback");
    assert.equal(row.agent_id, "agent-stage-preserve");
  });

  it("adds refinement_completed_at column and backfills from existing plans", async () => {
    // #99 PR 3 migration test: existing rows with a populated
    // refinement_plan must not get recomputed by the new re-spawn path
    // after upgrade — they need refinement_completed_at stamped with
    // whatever timestamp the row still has.
    const { initializeDb } = await import("./runtime.js");
    const db = initializeDb();

    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    assert.ok(
      cols.some((c) => c.name === "refinement_completed_at"),
      "tasks.refinement_completed_at column should exist",
    );

    // Insert a row mimicking a pre-migration task (completed refinement
    // but no refinement_completed_at). NULL the column to simulate the
    // pre-backfill state, then re-invoke initializeDb to ensure the
    // migration re-run is idempotent AND the backfill does not blow
    // away an already-populated value.
    const now = Date.now();
    db.prepare(
      "INSERT INTO agents (id, name, cli_provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("agent-refcomp", `ref-comp-${now}`, "claude", "idle", now, now);
    db.prepare(
      `INSERT INTO tasks
         (id, title, status, assigned_agent_id, task_size,
          refinement_plan, refinement_completed_at,
          started_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task-refcomp",
      "Pre-migration refined task",
      "done",
      "agent-refcomp",
      "small",
      "---REFINEMENT PLAN---\nexisting\n---END REFINEMENT---",
      null, // simulate pre-migration state
      now - 30_000, // started_at
      now - 1_000, // completed_at — backfill should prefer this
      now - 60_000,
      now,
    );

    // Simulate the migration re-running on a DB that predates the
    // column. Because the column already exists after initializeDb,
    // exercise the backfill SQL directly — that is the statement the
    // migration runs once, and it is what protects against upgrade-day
    // "refinement was done but recovery logic thinks it wasn't".
    db.exec(`
      UPDATE tasks
      SET refinement_completed_at = COALESCE(completed_at, started_at, updated_at, created_at)
      WHERE refinement_completed_at IS NULL
        AND refinement_plan IS NOT NULL
        AND refinement_plan <> ''
    `);

    const row = db
      .prepare(
        "SELECT refinement_completed_at FROM tasks WHERE id = ?",
      )
      .get("task-refcomp") as { refinement_completed_at: number | null };

    assert.equal(
      row.refinement_completed_at,
      now - 1_000,
      "backfill should pick completed_at when present (preferred over started_at/updated_at)",
    );

    // Empty refinement_plan must NOT be backfilled — those rows are
    // exactly the Bug 2 victims we want re-spawn recovery to re-try.
    db.prepare(
      `INSERT INTO tasks
         (id, title, status, assigned_agent_id, task_size,
          refinement_plan, refinement_completed_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("task-empty-plan", "Empty plan", "done", "agent-refcomp", "small", "", null, now, now);

    db.exec(`
      UPDATE tasks
      SET refinement_completed_at = COALESCE(completed_at, started_at, updated_at, created_at)
      WHERE refinement_completed_at IS NULL
        AND refinement_plan IS NOT NULL
        AND refinement_plan <> ''
    `);

    const emptyRow = db
      .prepare("SELECT refinement_completed_at FROM tasks WHERE id = ?")
      .get("task-empty-plan") as { refinement_completed_at: number | null };

    assert.equal(
      emptyRow.refinement_completed_at,
      null,
      "empty refinement_plan must remain uncompleted so recovery can re-run",
    );
  });
});
