import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import type { Agent, Task } from "../types/runtime.js";
import { dispatchAutoStartableTasks } from "./auto-dispatcher.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function createWs() {
  const sent: Array<{ type: string; payload: unknown }> = [];
  return {
    sent,
    broadcast(type: string, payload: unknown) {
      sent.push({ type, payload });
    },
  };
}

function insertSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(key, value, Date.now());
}

function insertAgent(db: DatabaseSync, overrides: Partial<Agent> = {}): Agent {
  const now = Date.now();
  const agent: Agent = {
    id: overrides.id ?? `agent-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "Implementer",
    cli_provider: overrides.cli_provider ?? "claude",
    cli_model: overrides.cli_model ?? "claude-opus-4-6",
    cli_reasoning_level: overrides.cli_reasoning_level ?? null,
    avatar_emoji: overrides.avatar_emoji ?? "🤖",
    role: overrides.role ?? "lead_engineer",
    agent_type: overrides.agent_type ?? "worker",
    personality: overrides.personality ?? null,
    status: overrides.status ?? "idle",
    current_task_id: overrides.current_task_id ?? null,
    stats_tasks_done: overrides.stats_tasks_done ?? 0,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };

  db.prepare(`
    INSERT INTO agents (
      id, name, cli_provider, cli_model, cli_reasoning_level, avatar_emoji, role,
      agent_type, personality, status, current_task_id, stats_tasks_done, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id,
    agent.name,
    agent.cli_provider,
    agent.cli_model,
    agent.cli_reasoning_level,
    agent.avatar_emoji,
    agent.role,
    agent.agent_type,
    agent.personality,
    agent.status,
    agent.current_task_id,
    agent.stats_tasks_done,
    agent.created_at,
    agent.updated_at,
  );

  return agent;
}

function insertTask(
  db: DatabaseSync,
  overrides: Partial<Task> & { external_source?: string | null; external_id?: string | null } = {},
): Task & { external_source: string | null; external_id: string | null } {
  const now = Date.now();
  const task: Task & { external_source: string | null; external_id: string | null } = {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2)}`,
    title: overrides.title ?? "Implement feature",
    description: overrides.description ?? null,
    assigned_agent_id: overrides.assigned_agent_id ?? null,
    project_path: overrides.project_path ?? "/tmp/agent-organizer",
    status: overrides.status ?? "inbox",
    priority: overrides.priority ?? 5,
    task_size: overrides.task_size ?? "medium",
    task_number: overrides.task_number ?? "#1",
    depends_on: overrides.depends_on ?? null,
    result: overrides.result ?? null,
    refinement_plan: overrides.refinement_plan ?? null,
    refinement_completed_at: overrides.refinement_completed_at ?? null,
    planned_files: overrides.planned_files ?? null,
    pr_url: overrides.pr_url ?? null,
    review_count: overrides.review_count ?? 0,
    directive_id: overrides.directive_id ?? null,
    interactive_prompt_data: overrides.interactive_prompt_data ?? null,
    review_branch: overrides.review_branch ?? null,
    review_commit_sha: overrides.review_commit_sha ?? null,
    review_sync_status: overrides.review_sync_status ?? "pending",
    review_sync_error: overrides.review_sync_error ?? null,
    repository_url: overrides.repository_url ?? null,
    repository_urls: null,
    pr_urls: null,
    merged_pr_urls: null,
    settings_overrides: null,
    external_source: overrides.external_source === undefined ? "github" : overrides.external_source,
    external_id: overrides.external_id === undefined ? "24" : overrides.external_id,
    started_at: overrides.started_at ?? null,
    completed_at: overrides.completed_at ?? null,
    auto_respawn_count: overrides.auto_respawn_count ?? 0,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };

  db.prepare(`
    INSERT INTO tasks (
      id, title, description, assigned_agent_id, project_path, status, priority, task_size,
      task_number, depends_on, result, review_count, directive_id, pr_url, external_source,
      external_id, interactive_prompt_data, review_branch, review_commit_sha, review_sync_status,
      review_sync_error, started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.title,
    task.description,
    task.assigned_agent_id,
    task.project_path,
    task.status,
    task.priority,
    task.task_size,
    task.task_number,
    task.depends_on,
    task.result,
    task.review_count,
    task.directive_id,
    task.pr_url,
    task.external_source,
    task.external_id,
    task.interactive_prompt_data,
    task.review_branch,
    task.review_commit_sha,
    task.review_sync_status,
    task.review_sync_error,
    task.started_at,
    task.completed_at,
    task.created_at,
    task.updated_at,
  );

  return task;
}

describe("dispatchAutoStartableTasks", () => {
  it("assigns and starts eligible GitHub tasks when an idle agent is available", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "github_only");
    const agent = insertAgent(db, { name: "Code Runner", cli_provider: "codex", role: "lead_engineer" });
    const task = insertTask(db, {
      title: "Fix API regression",
      description: "GitHub Issue: https://example.test/issues/24\nLabels: bug, backend",
      task_size: "small",
      priority: 8,
    });

    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask(taskToStart, assignedAgent) {
        const now = Date.now();
        db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?")
          .run(now, now, taskToStart.id);
        db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?")
          .run(taskToStart.id, now, assignedAgent.id);
      },
    });

    const startedTask = db.prepare("SELECT assigned_agent_id, status FROM tasks WHERE id = ?").get(task.id) as {
      assigned_agent_id: string | null;
      status: string;
    };
    const startedAgent = db.prepare("SELECT status, current_task_id FROM agents WHERE id = ?").get(agent.id) as {
      status: string;
      current_task_id: string | null;
    };

    assert.equal(result.started, 1);
    assert.equal(startedTask.assigned_agent_id, agent.id);
    assert.equal(startedTask.status, "in_progress");
    assert.equal(startedAgent.status, "working");
    assert.equal(startedAgent.current_task_id, task.id);
  });

  it("writes a skip reason when no idle worker is available", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "github_only");
    insertAgent(db, {
      name: "Busy Engineer",
      role: "lead_engineer",
      status: "working",
      current_task_id: "another-task",
    });
    const task = insertTask(db, {
      title: "Implement dispatcher",
    });

    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask() {
        throw new Error("should not start");
      },
    });

    const logs = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY id ASC"
    ).all(task.id) as Array<{ message: string }>;

    assert.equal(result.started, 0);
    assert.equal(result.skipped, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0].message, /no idle worker agent is available/i);
  });

  it("writes a skip reason when github_only mode excludes a non-GitHub task", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "github_only");
    insertAgent(db, { name: "Available Engineer", role: "lead_engineer" });
    const task = insertTask(db, {
      title: "Manual inbox task",
      external_source: null,
      external_id: null,
    });

    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask() {
        throw new Error("should not start");
      },
    });

    const logs = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY id ASC"
    ).all(task.id) as Array<{ message: string }>;

    assert.equal(result.started, 0);
    assert.equal(result.skipped, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0].message, /github-synced tasks only/i);
  });

  it("does not throw when startTask deletes the task before writeDispatchLog runs (FK 787 race)", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertAgent(db, { name: "Available", role: "lead_engineer" });
    const task = insertTask(db, { title: "Vanishes mid-tick" });

    // Reproduces the race that crashed the server during zombie
    // cleanup: startTask transitions the task out of inbox AND deletes
    // the row, then the dispatcher's failure branch tries to log
    // against the now-missing task and hits FK 787 on
    // INSERT INTO task_logs.
    assert.doesNotThrow(() => {
      const result = dispatchAutoStartableTasks(db, ws as never, {
        startTask(taskToStart) {
          db.prepare("DELETE FROM tasks WHERE id = ?").run(taskToStart.id);
          throw new Error("synthetic spawn failure after deletion");
        },
      });
      assert.equal(result.started, 0);
      assert.equal(result.skipped, 1);
    });
  });

  it("does not crash the dispatcher when an iteration body throws unexpectedly", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertAgent(db, { name: "Available", role: "lead_engineer" });
    const task = insertTask(db, { title: "Will explode" });

    // startTask synchronously throws — without the outer iteration
    // guard this would propagate up to the setInterval timer and
    // surface as `uncaughtException`. With the guard the next tick
    // simply records a `skipped`.
    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask() {
        // The startTask callsite already has a try/catch in the
        // assigned-agent branch, but we want to assert that a
        // non-recoverable throw on the unassigned branch is also
        // caught by the outer guard. Force the unassigned path by
        // throwing from within the chosen-agent branch.
        throw new Error("synthetic boom");
      },
    });

    // The iteration was caught: skipped count incremented, dispatch
    // did not throw, and a log entry survives on the still-existing
    // task row.
    assert.equal(result.skipped, 1);
    assert.equal(result.started, 0);

    const logs = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY id ASC",
    ).all(task.id) as Array<{ message: string }>;
    assert.ok(logs.length >= 1, "at least one dispatch log should survive");
    assert.ok(
      logs.some((l) => l.message.includes("synthetic boom") || l.message.includes("failed to start")),
      "the synthetic failure must appear in task_logs",
    );
  });
});
