import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../db/schema.js";
import type { Agent, Task } from "../types/runtime.js";
import { dispatchInboxTasks } from "./periodic-dispatch.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function insertAgent(db: DatabaseSync, overrides?: Partial<Agent>): Agent {
  const now = Date.now();
  const agent: Agent = {
    id: overrides?.id ?? "agent-1",
    name: overrides?.name ?? overrides?.id ?? "Worker",
    cli_provider: overrides?.cli_provider ?? "codex",
    cli_model: overrides?.cli_model ?? null,
    cli_reasoning_level: overrides?.cli_reasoning_level ?? null,
    avatar_emoji: overrides?.avatar_emoji ?? ":robot:",
    role: overrides?.role ?? null,
    agent_type: overrides?.agent_type ?? "worker",
    personality: overrides?.personality ?? null,
    status: overrides?.status ?? "idle",
    current_task_id: overrides?.current_task_id ?? null,
    stats_tasks_done: overrides?.stats_tasks_done ?? 0,
    created_at: overrides?.created_at ?? now,
    updated_at: overrides?.updated_at ?? now,
  };

  db.prepare(
    `INSERT INTO agents (
      id, name, cli_provider, cli_model, cli_reasoning_level, avatar_emoji, role, personality,
      status, current_task_id, stats_tasks_done, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    agent.id,
    agent.name,
    agent.cli_provider,
    agent.cli_model,
    agent.cli_reasoning_level,
    agent.avatar_emoji,
    agent.role,
    agent.personality,
    agent.status,
    agent.current_task_id,
    agent.stats_tasks_done,
    agent.created_at,
    agent.updated_at,
  );

  return agent;
}

function insertTask(db: DatabaseSync, overrides?: Partial<Task>): Task {
  const now = Date.now();
  const task: Task = {
    id: overrides?.id ?? "task-1",
    title: overrides?.title ?? "Task",
    description: overrides?.description ?? null,
    assigned_agent_id: overrides?.assigned_agent_id ?? null,
    project_path: overrides?.project_path ?? "/tmp/project",
    status: overrides?.status ?? "inbox",
    priority: overrides?.priority ?? 5,
    task_size: overrides?.task_size ?? "medium",
    task_number: overrides?.task_number ?? "#1",
    depends_on: overrides?.depends_on ?? null,
    result: overrides?.result ?? null,
    pr_url: overrides?.pr_url ?? null,
    external_source: overrides?.external_source ?? "manual",
    external_id: overrides?.external_id ?? null,
    review_count: overrides?.review_count ?? 0,
    directive_id: overrides?.directive_id ?? null,
    interactive_prompt_data: overrides?.interactive_prompt_data ?? null,
    review_branch: overrides?.review_branch ?? null,
    review_commit_sha: overrides?.review_commit_sha ?? null,
    review_sync_status: overrides?.review_sync_status ?? "pending",
    review_sync_error: overrides?.review_sync_error ?? null,
    repository_url: overrides?.repository_url ?? null,
    started_at: overrides?.started_at ?? null,
    completed_at: overrides?.completed_at ?? null,
    created_at: overrides?.created_at ?? now,
    updated_at: overrides?.updated_at ?? now,
  };

  db.prepare(
    `INSERT INTO tasks (
      id, title, description, assigned_agent_id, project_path, status, priority, task_size, task_number,
      depends_on, result, review_count, directive_id, pr_url, external_source, external_id,
      interactive_prompt_data, review_branch, review_commit_sha, review_sync_status, review_sync_error,
      started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
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

function createWs() {
  const sent: Array<{ type: string; payload: unknown }> = [];
  return {
    sent,
    broadcast(type: string, payload: unknown) {
      sent.push({ type, payload });
    },
  };
}

describe("dispatchInboxTasks", () => {
  it("dispatches inbox backlog until idle agents are exhausted", () => {
    const db = createDb();
    const ws = createWs();
    insertAgent(db, { id: "agent-1", updated_at: 1 });
    insertAgent(db, { id: "agent-2", updated_at: 2 });
    insertTask(db, { id: "task-1", priority: 10, created_at: 10, updated_at: 10 });
    insertTask(db, { id: "task-2", priority: 8, created_at: 20, updated_at: 20 });
    insertTask(db, { id: "task-3", priority: 1, created_at: 30, updated_at: 30 });

    const started = dispatchInboxTasks(db, ws as never, {
      autoAssign: true,
      autoRun: true,
      spawnAgent: (innerDb, _ws, agent, task) => {
        const now = Date.now();
        innerDb.prepare("UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?")
          .run(agent.id, now, now, task.id);
        innerDb.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?")
          .run(task.id, now, agent.id);
        return { pid: 123 };
      },
    });

    const rows = db.prepare("SELECT id, status, assigned_agent_id FROM tasks ORDER BY priority DESC, created_at ASC").all() as Array<{
      id: string;
      status: string;
      assigned_agent_id: string | null;
    }>;

    assert.deepEqual(started, ["task-1", "task-2"]);
    assert.deepEqual(
      rows.map((row) => ({ id: row.id, status: row.status })),
      [
        { id: "task-1", status: "in_progress" },
        { id: "task-2", status: "in_progress" },
        { id: "task-3", status: "inbox" },
      ],
    );
    assert.equal(rows[0].assigned_agent_id, "agent-1");
    assert.equal(rows[1].assigned_agent_id, "agent-2");
    assert.equal(rows[2].assigned_agent_id, null);
  });

  it("does nothing when auto run is disabled", () => {
    const db = createDb();
    const ws = createWs();
    insertAgent(db);
    insertTask(db, { id: "task-1" });

    const started = dispatchInboxTasks(db, ws as never, {
      autoAssign: true,
      autoRun: false,
      spawnAgent: () => {
        throw new Error("should not spawn");
      },
    });

    const row = db.prepare("SELECT status, assigned_agent_id FROM tasks WHERE id = ?").get("task-1") as {
      status: string;
      assigned_agent_id: string | null;
    };

    assert.deepEqual(started, []);
    assert.equal(row.status, "inbox");
    assert.equal(row.assigned_agent_id, null);
  });
});
