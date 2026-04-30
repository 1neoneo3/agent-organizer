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

  it("does not start controller children before their directive stage opens", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertSetting(db, "enable_controller_mode", "true");
    insertAgent(db, { name: "Available Engineer", role: "lead_engineer" });
    const now = Date.now();
    db.prepare(
      `INSERT INTO directives (
         id, title, content, status, controller_mode, controller_stage, created_at, updated_at
       ) VALUES ('d-controller', 'Controller', 'Controller', 'active', 1, 'implement', ?, ?)`,
    ).run(now, now);
    const task = insertTask(db, {
      title: "Verify later",
      external_source: null,
      external_id: null,
      directive_id: "d-controller",
    });
    db.prepare("UPDATE tasks SET controller_stage = 'verify' WHERE id = ?").run(task.id);

    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask() {
        throw new Error("should not start");
      },
    });

    const row = db.prepare("SELECT status, assigned_agent_id FROM tasks WHERE id = ?").get(task.id) as {
      status: string;
      assigned_agent_id: string | null;
    };
    assert.equal(result.started, 0);
    assert.equal(row.status, "inbox");
    assert.equal(row.assigned_agent_id, null);
  });

  it("keeps legacy dispatch behavior for controller fields when controller mode is disabled", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertSetting(db, "enable_controller_mode", "false");
    insertAgent(db, { name: "Available Engineer", role: "lead_engineer" });
    const now = Date.now();
    db.prepare(
      `INSERT INTO directives (
         id, title, content, status, controller_mode, controller_stage, created_at, updated_at
       ) VALUES ('d-controller-off', 'Controller', 'Controller', 'active', 1, 'implement', ?, ?)`,
    ).run(now, now);
    const task = insertTask(db, {
      title: "Verify can run when feature is off",
      external_source: null,
      external_id: null,
      directive_id: "d-controller-off",
    });
    db.prepare("UPDATE tasks SET controller_stage = 'verify' WHERE id = ?").run(task.id);

    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask(taskToStart, assignedAgent) {
        const updatedAt = Date.now();
        db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?")
          .run(updatedAt, updatedAt, taskToStart.id);
        db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?")
          .run(taskToStart.id, updatedAt, assignedAgent.id);
      },
    });

    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as { status: string };
    assert.equal(result.started, 1);
    assert.equal(row.status, "in_progress");
  });

  it("does not dispatch serial controller implement children with overlapping write_scope at the same time", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertSetting(db, "enable_controller_mode", "true");
    insertAgent(db, { name: "Engineer A", role: "lead_engineer" });
    insertAgent(db, { name: "Engineer B", role: "lead_engineer" });
    const now = Date.now();
    db.prepare(
      `INSERT INTO directives (
         id, title, content, status, controller_mode, controller_stage, created_at, updated_at
       ) VALUES ('d-overlap', 'Controller', 'Controller', 'active', 1, 'implement', ?, ?)`,
    ).run(now, now);
    const first = insertTask(db, {
      title: "Implement first",
      task_number: "T01",
      external_source: null,
      external_id: null,
      directive_id: "d-overlap",
    });
    const second = insertTask(db, {
      title: "Implement second",
      task_number: "T02",
      depends_on: '["T01"]',
      external_source: null,
      external_id: null,
      directive_id: "d-overlap",
    });
    db.prepare(
      "UPDATE tasks SET controller_stage = 'implement', write_scope = ?, planned_files = ? WHERE id IN (?, ?)",
    ).run('["server/shared.ts"]', '["server/shared.ts"]', first.id, second.id);

    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask(taskToStart, assignedAgent) {
        const updatedAt = Date.now();
        db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?")
          .run(updatedAt, updatedAt, taskToStart.id);
        db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?")
          .run(taskToStart.id, updatedAt, assignedAgent.id);
      },
    });

    const rows = db.prepare("SELECT task_number, status FROM tasks WHERE directive_id = 'd-overlap' ORDER BY task_number").all() as Array<{
      task_number: string;
      status: string;
    }>;
    assert.equal(result.started, 1);
    assert.deepStrictEqual(rows.map((row) => [row.task_number, row.status]), [
      ["T01", "in_progress"],
      ["T02", "inbox"],
    ]);
  });

  it("dispatches controller verify children with overlapping write_scope in parallel", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertSetting(db, "enable_controller_mode", "true");
    insertAgent(db, { id: "agent-verify-a", name: "Verifier A", role: "lead_engineer" });
    insertAgent(db, { id: "agent-verify-b", name: "Verifier B", role: "lead_engineer" });
    const now = Date.now();
    db.prepare(
      `INSERT INTO directives (
         id, title, content, status, controller_mode, controller_stage, created_at, updated_at
       ) VALUES ('d-verify-overlap', 'Controller', 'Controller', 'active', 1, 'verify', ?, ?)`,
    ).run(now, now);
    const first = insertTask(db, {
      title: "Verify first",
      task_number: "T01",
      external_source: null,
      external_id: null,
      directive_id: "d-verify-overlap",
    });
    const second = insertTask(db, {
      title: "Verify second",
      task_number: "T02",
      external_source: null,
      external_id: null,
      directive_id: "d-verify-overlap",
    });
    db.prepare(
      "UPDATE tasks SET controller_stage = 'verify', write_scope = ?, planned_files = ? WHERE id IN (?, ?)",
    ).run('["server/shared.ts"]', '["server/shared.ts"]', first.id, second.id);

    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask(taskToStart, assignedAgent) {
        const updatedAt = Date.now();
        db.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ?")
          .run(updatedAt, updatedAt, taskToStart.id);
        db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?")
          .run(taskToStart.id, updatedAt, assignedAgent.id);
      },
    });

    const rows = db.prepare("SELECT task_number, status FROM tasks WHERE directive_id = 'd-verify-overlap' ORDER BY task_number").all() as Array<{
      task_number: string;
      status: string;
    }>;
    assert.equal(result.started, 2);
    assert.deepStrictEqual(rows.map((row) => [row.task_number, row.status]), [
      ["T01", "in_progress"],
      ["T02", "in_progress"],
    ]);
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

  it("reports skipped via the existing inner catch when startTask throws", () => {
    // This test exercises the *inner* try/catch around startTask
    // (lines 381-396 of auto-dispatcher.ts), which has been there
    // long before Layer 2. Documenting it explicitly because the
    // FK-race fix added a Layer 2 outer guard, and we want to keep
    // the inner guard's behavior pinned to avoid accidental removal.
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertAgent(db, { name: "Available", role: "lead_engineer" });
    const task = insertTask(db, { title: "Will explode" });

    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask() {
        throw new Error("synthetic boom");
      },
    });

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

  it("uses the configured refinement_agent_role override when refinement is the first active stage", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "refinement_agent_role", "planner");

    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer", stats_tasks_done: 0 });
    insertAgent(db, { id: "planner-1", name: "Planner", role: "planner", stats_tasks_done: 99 });
    insertTask(db, {
      id: "task-refinement",
      title: "Plan something",
      external_source: null,
      external_id: null,
    });

    const started: string[] = [];
    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask(task, agent) {
        started.push(agent.id);
        const updatedAt = Date.now();
        db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?")
          .run(updatedAt, task.id);
        db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?")
          .run(task.id, updatedAt, agent.id);
      },
    });

    assert.equal(result.started, 1);
    assert.deepEqual(started, ["planner-1"]);
  });

  it("skips refinement tasks when the override is configured but no matching idle worker exists", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "refinement_agent_role", "planner");

    // No planner registered — only an unrelated lead engineer is idle.
    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer" });
    const task = insertTask(db, {
      id: "task-no-match",
      title: "Plan something",
      external_source: null,
      external_id: null,
    });

    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask() {
        throw new Error("must not start without a matching planner");
      },
    });

    assert.equal(result.started, 0);
    assert.equal(result.skipped, 1);
    const logs = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY id ASC",
    ).all(task.id) as Array<{ message: string }>;
    assert.match(
      logs.at(-1)?.message ?? "",
      /no matching idle worker/i,
    );
  });

  it("skips a second refinement task when the only matching worker was already consumed in this tick", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "refinement_agent_role", "planner");

    insertAgent(db, { id: "planner-1", name: "Planner", role: "planner" });
    // Two refinement tasks, only one planner — the second must skip with
    // "already taken in this tick" rather than being dispatched to a
    // non-matching worker.
    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer" });
    const t1 = insertTask(db, {
      id: "task-refine-1",
      title: "Plan A",
      task_number: "#A",
      external_source: null,
      external_id: null,
      created_at: Date.now() - 1000,
    });
    const t2 = insertTask(db, {
      id: "task-refine-2",
      title: "Plan B",
      task_number: "#B",
      external_source: null,
      external_id: null,
      created_at: Date.now(),
    });

    // startTask intentionally does NOT update agents.status to 'working'
    // so we can probe the candidatePool path: in production spawnAgent
    // updates the agent status asynchronously, so within a single
    // dispatch tick the consumed agent can still appear status=idle in
    // the DB. The dispatcher's `availableAgents.delete(...)` is what
    // protects against re-dispatching the same agent — the resolver
    // surfaces this as configured_no_match_in_pool.
    const started: string[] = [];
    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask(task, agent) {
        started.push(`${task.id}:${agent.id}`);
        const updatedAt = Date.now();
        db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?")
          .run(updatedAt, task.id);
        // agents.status NOT updated here on purpose.
      },
    });

    assert.equal(result.started, 1, "exactly the first task must run");
    assert.deepEqual(started, [`${t1.id}:planner-1`]);
    const t2Logs = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY id ASC",
    ).all(t2.id) as Array<{ message: string }>;
    assert.match(
      t2Logs.at(-1)?.message ?? "",
      /already taken in this tick/i,
    );
  });

  it("dispatches a second matching planner to a second refinement task in the same tick (candidate pool reuse)", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertSetting(db, "default_enable_refinement", "true");
    insertSetting(db, "refinement_agent_role", "planner");

    insertAgent(db, { id: "planner-1", name: "Planner1", role: "planner" });
    insertAgent(db, { id: "planner-2", name: "Planner2", role: "planner" });
    insertTask(db, {
      id: "task-refine-1",
      title: "Plan A",
      task_number: "#A",
      external_source: null,
      external_id: null,
      created_at: Date.now() - 1000,
    });
    insertTask(db, {
      id: "task-refine-2",
      title: "Plan B",
      task_number: "#B",
      external_source: null,
      external_id: null,
      created_at: Date.now(),
    });

    const startedAgents = new Set<string>();
    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask(task, agent) {
        startedAgents.add(agent.id);
        const updatedAt = Date.now();
        db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?")
          .run(updatedAt, task.id);
        db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?")
          .run(task.id, updatedAt, agent.id);
      },
    });

    assert.equal(result.started, 2);
    assert.deepEqual([...startedAgents].sort(), ["planner-1", "planner-2"]);
  });

  it("falls back to chooseBestAgent when refinement is not the first active stage even with override configured", () => {
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    // default_enable_refinement = "false" → first stage is in_progress.
    insertSetting(db, "default_enable_refinement", "false");
    insertSetting(db, "refinement_agent_role", "planner");

    // No planner exists, and the override would normally cause skip;
    // but since refinement isn't in the active pipeline, the lead
    // engineer should be picked by chooseBestAgent.
    insertAgent(db, { id: "lead-1", name: "Lead", role: "lead_engineer" });
    insertTask(db, {
      id: "task-non-refine",
      title: "Implement feature",
      external_source: null,
      external_id: null,
    });

    const result = dispatchAutoStartableTasks(db, ws as never, {
      startTask(task, agent) {
        const updatedAt = Date.now();
        db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?")
          .run(updatedAt, task.id);
        db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, updated_at = ? WHERE id = ?")
          .run(task.id, updatedAt, agent.id);
      },
    });

    assert.equal(result.started, 1);
  });

  it("Layer 2: catches errors that escape the inner try (startTask throws synchronously)", () => {
    // Reproduces a Layer-2-only scenario: the throw originates from
    // startTask (synchronous throw rather than async rejection).
    // Without the outer iteration guard the throw would bubble to
    // setInterval and crash the dispatcher process.
    const db = createDb();
    const ws = createWs();
    insertSetting(db, "auto_dispatch_mode", "all_inbox");
    insertAgent(db, { name: "Available", role: "lead_engineer" });
    insertTask(db, { title: "Will trip startTask" });

    let result: ReturnType<typeof dispatchAutoStartableTasks> | undefined;
    assert.doesNotThrow(() => {
      result = dispatchAutoStartableTasks(db, ws as never, {
        startTask() {
          throw new Error("synthetic startTask failure (Layer 2 trigger)");
        },
      });
    });

    assert.ok(result, "dispatch must return a summary, not propagate the throw");
    assert.ok(result!.skipped >= 1, `expected skipped >= 1, got ${result!.skipped}`);
    assert.equal(result!.started, 0);
  });
});
