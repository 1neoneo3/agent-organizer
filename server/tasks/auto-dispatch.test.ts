import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../db/schema.js";
import type { Agent, Task } from "../types/runtime.js";
import { autoDispatchTask, pickInboxAgent } from "./auto-dispatch.js";

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
    name: overrides?.name ?? "Worker",
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
      id, name, cli_provider, cli_model, cli_reasoning_level, avatar_emoji, role, agent_type, personality,
      status, current_task_id, stats_tasks_done, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
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
    refinement_plan: overrides?.refinement_plan ?? null,
    refinement_completed_at: overrides?.refinement_completed_at ?? null,
    planned_files: overrides?.planned_files ?? null,
    pr_url: overrides?.pr_url ?? null,
    external_source: overrides?.external_source ?? "github",
    external_id: overrides?.external_id ?? "1",
    review_count: overrides?.review_count ?? 0,
    directive_id: overrides?.directive_id ?? null,
    interactive_prompt_data: overrides?.interactive_prompt_data ?? null,
    review_branch: overrides?.review_branch ?? null,
    review_commit_sha: overrides?.review_commit_sha ?? null,
    review_sync_status: overrides?.review_sync_status ?? "pending",
    review_sync_error: overrides?.review_sync_error ?? null,
    repository_url: overrides?.repository_url ?? null,
    repository_urls: null,
    pr_urls: null,
    merged_pr_urls: null,
    settings_overrides: null,
    started_at: overrides?.started_at ?? null,
    completed_at: overrides?.completed_at ?? null,
    auto_respawn_count: overrides?.auto_respawn_count ?? 0,
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

describe("autoDispatchTask", () => {
  it("assigns an idle agent when auto assign is enabled", () => {
    const db = createDb();
    const ws = createWs();
    insertAgent(db);
    insertTask(db);

    autoDispatchTask(db, ws as never, "task-1", {
      autoAssign: true,
      autoRun: false,
      spawnAgent: () => Promise.resolve({ pid: 123 }),
    });

    const row = db.prepare("SELECT assigned_agent_id, status, updated_at FROM tasks WHERE id = ?").get("task-1") as {
      assigned_agent_id: string | null;
      status: string;
      updated_at: number;
    };

    assert.equal(row.assigned_agent_id, "agent-1");
    assert.equal(row.status, "inbox");
    assert.equal(ws.sent.filter((event) => event.type === "task_update").length, 1);
    assert.deepEqual(ws.sent[0], {
      type: "task_update",
      payload: {
        id: "task-1",
        assigned_agent_id: "agent-1",
        updated_at: row.updated_at,
      },
    });
  });

  it("starts the assigned task when auto run is enabled and the agent is idle", () => {
    const db = createDb();
    const ws = createWs();
    insertAgent(db);
    insertTask(db, { assigned_agent_id: "agent-1" });
    const started: Array<{ agentId: string; taskId: string }> = [];

    autoDispatchTask(db, ws as never, "task-1", {
      autoAssign: false,
      autoRun: true,
      spawnAgent: (_db, _ws, agent, task) => {
        started.push({ agentId: agent.id, taskId: task.id });
        return Promise.resolve({ pid: 123 });
      },
    });

    assert.deepEqual(started, [{ agentId: "agent-1", taskId: "task-1" }]);
  });

  it("does not start the task when the assigned agent is busy", () => {
    const db = createDb();
    const ws = createWs();
    insertAgent(db, { status: "working", current_task_id: "other-task" });
    insertTask(db, { assigned_agent_id: "agent-1" });
    let spawnCalls = 0;

    autoDispatchTask(db, ws as never, "task-1", {
      autoAssign: false,
      autoRun: true,
      spawnAgent: () => {
        spawnCalls += 1;
        return Promise.resolve({ pid: 123 });
      },
    });

    assert.equal(spawnCalls, 0);
  });

  it("skips inbox tasks that have reached the review_count max", () => {
    const db = createDb();
    const ws = createWs();
    insertAgent(db);
    // review_count=3, default max is 3
    insertTask(db, { assigned_agent_id: "agent-1", review_count: 3 });
    let spawnCalls = 0;

    autoDispatchTask(db, ws as never, "task-1", {
      autoAssign: false,
      autoRun: true,
      spawnAgent: () => {
        spawnCalls += 1;
        return Promise.resolve({ pid: 123 });
      },
    });

    assert.equal(spawnCalls, 0, "should not spawn agent for review-maxed inbox task");
  });

  it("dispatches inbox tasks with review_count below max", () => {
    const db = createDb();
    const ws = createWs();
    insertAgent(db);
    insertTask(db, { assigned_agent_id: "agent-1", review_count: 1 });
    let spawnCalls = 0;

    autoDispatchTask(db, ws as never, "task-1", {
      autoAssign: false,
      autoRun: true,
      spawnAgent: () => {
        spawnCalls += 1;
        return Promise.resolve({ pid: 123 });
      },
    });

    assert.equal(spawnCalls, 1, "should spawn agent when review_count < max");
  });
});

function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, Date.now());
}

describe("pickInboxAgent (stage-specific refinement override)", () => {
  // Regression coverage for the bug where POST /tasks → autoDispatchTask
  // ignored `refinement_agent_role` / `refinement_agent_model` because it
  // delegated to the legacy `pickIdleAgent`. The fix routes inbox-time
  // selection through the same stage resolver that the periodic
  // dispatcher uses, so the configured Plan-Stage agent is honoured at
  // task creation as well.

  it("uses the refinement_agent_role override when refinement is the first active stage", () => {
    const db = createDb();
    setSetting(db, "default_enable_refinement", "true");
    setSetting(db, "refinement_agent_role", "planner");

    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer", stats_tasks_done: 0 });
    insertAgent(db, { id: "planner-1", name: "Planner", role: "planner", stats_tasks_done: 5 });
    const task = insertTask(db, { project_path: null });

    const picked = pickInboxAgent(db, task);
    assert.equal(picked?.id, "planner-1");
  });

  it("matches on cli_model when refinement_agent_model is configured", () => {
    const db = createDb();
    setSetting(db, "default_enable_refinement", "true");
    setSetting(db, "refinement_agent_role", "planner");
    setSetting(db, "refinement_agent_model", "claude-opus-4-7");

    insertAgent(db, {
      id: "planner-mismatch",
      name: "PlannerA",
      role: "planner",
      cli_model: "gpt-5.5",
    });
    insertAgent(db, {
      id: "planner-match",
      name: "PlannerB",
      role: "planner",
      cli_model: "claude-opus-4-7",
    });
    const task = insertTask(db, { project_path: null });

    const picked = pickInboxAgent(db, task);
    assert.equal(picked?.id, "planner-match");
  });

  it("falls back to pickIdleAgent when refinement is not in the active pipeline", () => {
    const db = createDb();
    // default_enable_refinement is "false" by default → first stage is in_progress.
    setSetting(db, "refinement_agent_role", "planner");

    insertAgent(db, { id: "planner-1", name: "Planner", role: "planner", stats_tasks_done: 5 });
    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer", stats_tasks_done: 0 });
    const task = insertTask(db, { project_path: null });

    const picked = pickInboxAgent(db, task);
    // pickIdleAgent orders by stats_tasks_done ASC, so lead-1 wins.
    assert.equal(picked?.id, "lead-1");
  });

  it("returns undefined when the override is configured but no matching idle agent exists (strict mode)", () => {
    const db = createDb();
    setSetting(db, "default_enable_refinement", "true");
    setSetting(db, "refinement_agent_role", "planner");

    // No planner agent exists. Strict semantics: do NOT fall back to a
    // non-matching agent, leave the task in inbox so the periodic
    // dispatcher can retry once a matching agent appears.
    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer" });
    const task = insertTask(db, { project_path: null });

    assert.equal(pickInboxAgent(db, task), undefined);
  });

  it("returns undefined when the override matches an agent that is currently busy (strict mode)", () => {
    const db = createDb();
    setSetting(db, "default_enable_refinement", "true");
    setSetting(db, "refinement_agent_role", "planner");

    insertAgent(db, {
      id: "planner-1",
      name: "Planner",
      role: "planner",
      status: "working",
      current_task_id: "other",
    });
    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer" });
    const task = insertTask(db, { project_path: null });

    assert.equal(pickInboxAgent(db, task), undefined);
  });

  it("returns undefined when no idle agent is available at all", () => {
    const db = createDb();
    setSetting(db, "default_enable_refinement", "true");
    setSetting(db, "refinement_agent_role", "planner");

    insertAgent(db, {
      id: "busy-1",
      name: "Busy",
      role: "planner",
      status: "working",
      current_task_id: "other",
    });
    const task = insertTask(db, { project_path: null });

    assert.equal(pickInboxAgent(db, task), undefined);
  });

  it("ignores the override when both role and model settings are empty", () => {
    const db = createDb();
    setSetting(db, "default_enable_refinement", "true");
    setSetting(db, "refinement_agent_role", "");
    setSetting(db, "refinement_agent_model", "");

    insertAgent(db, { id: "planner-1", name: "Planner", role: "planner", stats_tasks_done: 5 });
    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer", stats_tasks_done: 0 });
    const task = insertTask(db, { project_path: null });

    const picked = pickInboxAgent(db, task);
    // Empty filters → fallback to pickIdleAgent (lowest stats_tasks_done).
    assert.equal(picked?.id, "lead-1");
  });

  it("does not select a ceo agent through the override path even when role matches", () => {
    const db = createDb();
    setSetting(db, "default_enable_refinement", "true");
    setSetting(db, "refinement_agent_role", "planner");

    // The CEO has the matching role/agent_type combo BUT is filtered out
    // by resolveStageAgentOverride's `agent_type = 'worker'` constraint,
    // so a worker-typed planner must win the override match.
    insertAgent(db, { id: "ceo-1", name: "CEO", role: "planner", agent_type: "ceo" });
    insertAgent(db, {
      id: "planner-worker",
      name: "PlannerW",
      role: "planner",
      agent_type: "worker",
    });
    const task = insertTask(db, { project_path: null });

    const picked = pickInboxAgent(db, task);
    assert.equal(picked?.id, "planner-worker");
  });
});

describe("autoDispatchTask + refinement_agent settings (integration)", () => {
  it("assigns the configured refinement agent at task creation", () => {
    const db = createDb();
    const ws = createWs();
    setSetting(db, "default_enable_refinement", "true");
    setSetting(db, "refinement_agent_role", "planner");

    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer", stats_tasks_done: 0 });
    insertAgent(db, { id: "planner-1", name: "Planner", role: "planner", stats_tasks_done: 99 });
    insertTask(db, { project_path: null });

    autoDispatchTask(db, ws as never, "task-1", {
      autoAssign: true,
      autoRun: false,
      spawnAgent: () => Promise.resolve({ pid: 0 }),
    });

    const row = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get("task-1") as {
      assigned_agent_id: string | null;
    };
    assert.equal(row.assigned_agent_id, "planner-1");
  });

  it("leaves the task unassigned when the refinement override is configured but no matching agent exists (strict mode)", () => {
    const db = createDb();
    const ws = createWs();
    setSetting(db, "default_enable_refinement", "true");
    setSetting(db, "refinement_agent_role", "planner"); // No planner exists.

    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer", stats_tasks_done: 0 });
    insertTask(db, { project_path: null });

    autoDispatchTask(db, ws as never, "task-1", {
      autoAssign: true,
      autoRun: false,
      spawnAgent: () => Promise.resolve({ pid: 0 }),
    });

    const row = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get("task-1") as {
      assigned_agent_id: string | null;
    };
    // Strict: configured_no_match must not silently fall back to lead-1.
    assert.equal(row.assigned_agent_id, null);
  });
});
