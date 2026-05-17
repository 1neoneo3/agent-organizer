import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../../db/schema.js";
import type { Task } from "../../types/runtime.js";
import { buildTaskSummaryUpdate, pickTaskUpdate } from "../update-payloads.js";

describe("pickTaskUpdate", () => {
  it("keeps only the requested keys", () => {
    const payload = pickTaskUpdate(
      {
        id: "task-1",
        title: "Keep title",
        status: "in_progress",
        description: "drop me",
        refinement_plan: "drop me too",
        assigned_agent_id: "agent-1",
      },
      ["title", "status", "assigned_agent_id"],
    );

    assert.deepEqual(payload, {
      id: "task-1",
      title: "Keep title",
      status: "in_progress",
      assigned_agent_id: "agent-1",
    });
  });

  it("omits undefined fields while preserving nulls", () => {
    const payload = pickTaskUpdate(
      {
        id: "task-1",
        completed_at: null,
        started_at: undefined,
        pr_url: null,
      },
      ["started_at", "completed_at", "pr_url"],
    );

    assert.deepEqual(payload, {
      id: "task-1",
      completed_at: null,
      pr_url: null,
    });
  });
});

describe("buildTaskSummaryUpdate", () => {
  it("hydrates legacy controller integrate parent metadata from sibling split tasks", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(SCHEMA_SQL);
      const now = Date.now();
      db.prepare(
        `INSERT INTO directives (
          id, title, content, status, project_path, controller_mode, controller_stage,
          created_at, updated_at
        ) VALUES ('directive-integrate', 'Controller: #920 親のController作業', 'content', 'active', '/tmp/project', 1, 'integrate', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO tasks (
          id, title, description, status, task_size, task_number, created_at, updated_at
        ) VALUES ('controller-parent', '親のController作業', 'parent', 'done', 'large', '#920', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO tasks (
          id, title, description, status, task_size, task_number,
          parent_task_id, parent_task_number, directive_id, controller_stage,
          created_at, updated_at
        ) VALUES ('controller-child', '実装子タスク', 'child', 'done', 'small', '#921',
          'controller-parent', '#920', 'directive-integrate', 'implement', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO tasks (
          id, title, description, status, task_size, task_number,
          directive_id, controller_stage, created_at, updated_at
        ) VALUES ('controller-integrate', 'Integrate controller results', 'integrate', 'inbox', 'small', 'T02',
          'directive-integrate', 'integrate', ?, ?)`,
      ).run(now, now);

      const task = db.prepare("SELECT * FROM tasks WHERE id = 'controller-integrate'").get() as unknown as Task;
      const payload = buildTaskSummaryUpdate(task, { db });

      assert.equal(payload.parent_task_id, "controller-parent");
      assert.equal(payload.parent_task_number, "#920");
      assert.equal(payload.parent_task_title, "親のController作業");
    } finally {
      db.close();
    }
  });
});
