import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import type { Directive } from "../types/runtime.js";
import {
  findUnsafeWriteScopeOverlap,
  isControllerTaskStartable,
  reconcileControllerDirective,
  splitDirectiveIntoControllerTasks,
} from "./orchestrator.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function createWs() {
  return {
    sent: [] as Array<{ type: string; payload: unknown }>,
    broadcast(type: string, payload: unknown) {
      this.sent.push({ type, payload });
    },
  };
}

function createCtx(db: DatabaseSync, ws: ReturnType<typeof createWs>) {
  return { db, ws: ws as never };
}

function insertDirective(db: DatabaseSync, overrides: Partial<Directive> = {}): Directive {
  const now = Date.now();
  const directive = {
    id: overrides.id ?? "directive-1",
    title: overrides.title ?? "Build controller",
    content: overrides.content ?? "Split and run work",
    issued_by_type: overrides.issued_by_type ?? "user",
    issued_by_id: overrides.issued_by_id ?? null,
    status: overrides.status ?? "pending",
    project_path: overrides.project_path ?? "/tmp/project",
    controller_mode: overrides.controller_mode ?? 0,
    controller_stage: overrides.controller_stage ?? null,
    aggregated_result: overrides.aggregated_result ?? null,
    completed_at: overrides.completed_at ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  } satisfies Directive;

  db.prepare(
    `INSERT INTO directives (
       id, title, content, issued_by_type, issued_by_id, status, project_path,
       controller_mode, controller_stage, aggregated_result, completed_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    directive.id,
    directive.title,
    directive.content,
    directive.issued_by_type,
    directive.issued_by_id,
    directive.status,
    directive.project_path,
    directive.controller_mode,
    directive.controller_stage,
    directive.aggregated_result,
    directive.completed_at,
    directive.created_at,
    directive.updated_at,
  );

  return directive;
}

describe("controller orchestrator", () => {
  it("splits a directive into staged worker tasks with role, write_scope, and dependencies", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);

    const result = splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      {
        task_number: "T01",
        title: "Implement API",
        controller_stage: "implement",
        controller_role: "lead_engineer",
        write_scope: ["server/routes/directives.ts"],
      },
      {
        task_number: "T02",
        title: "Verify API",
        controller_stage: "verify",
        controller_role: "tester",
        depends_on: ["T01"],
      },
      {
        task_number: "T03",
        title: "Integrate result",
        controller_stage: "integrate",
        controller_role: "lead_engineer",
        depends_on: ["T02"],
      },
    ]);

    assert.equal(result.directive.controller_mode, 1);
    assert.equal(result.directive.status, "active");
    assert.equal(result.directive.controller_stage, "implement");
    assert.equal(result.tasks.length, 3);
    assert.equal(result.tasks[0].controller_role, "lead_engineer");
    assert.deepStrictEqual(JSON.parse(result.tasks[0].write_scope ?? "[]"), ["server/routes/directives.ts"]);
    assert.equal(result.tasks[1].depends_on, '["T01"]');
    assert.ok(ws.sent.some((entry) => entry.type === "directive_update"));
    assert.equal(ws.sent.filter((entry) => entry.type === "task_update").length, 3);
  });

  it("rejects parallel implement children that overlap write_scope", () => {
    const overlap = findUnsafeWriteScopeOverlap([
      {
        task_number: "T01",
        title: "A",
        controller_stage: "implement",
        write_scope: ["server/a.ts"],
      },
      {
        task_number: "T02",
        title: "B",
        controller_stage: "implement",
        write_scope: ["server/a.ts"],
      },
    ]);

    assert.match(overlap ?? "", /overlap write_scope/);
  });

  it("advances from implement to verify only after all current stage tasks are done", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);
    splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      { task_number: "T01", title: "Implement A", controller_stage: "implement" },
      { task_number: "T02", title: "Verify", controller_stage: "verify", depends_on: ["T01"] },
    ]);

    const verifyTaskBefore = db.prepare("SELECT * FROM tasks WHERE task_number = 'T02'").get() as any;
    assert.equal(isControllerTaskStartable(db, verifyTaskBefore), false);

    db.prepare("UPDATE tasks SET status = 'done' WHERE task_number = 'T01' AND directive_id = ?").run(directive.id);
    const advanced = reconcileControllerDirective(createCtx(db, ws), directive.id);

    assert.equal(advanced?.controller_stage, "verify");
    const verifyTaskAfter = db.prepare("SELECT * FROM tasks WHERE task_number = 'T02'").get() as any;
    assert.equal(isControllerTaskStartable(db, verifyTaskAfter), true);
  });

  it("does not treat cancelled children as stage complete", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);
    splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      { task_number: "T01", title: "Implement A", controller_stage: "implement" },
      { task_number: "T02", title: "Verify", controller_stage: "verify", depends_on: ["T01"] },
    ]);

    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE task_number = 'T01' AND directive_id = ?").run(directive.id);
    const updated = reconcileControllerDirective(createCtx(db, ws), directive.id);

    assert.equal(updated?.status, "active");
    assert.equal(updated?.controller_stage, "blocked");
    const verifyTask = db.prepare("SELECT * FROM tasks WHERE task_number = 'T02'").get() as any;
    assert.equal(isControllerTaskStartable(db, verifyTask), false);
  });

  it("copies integrate result to the directive idempotently", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);
    splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      { task_number: "T01", title: "Implement A", controller_stage: "implement" },
      { task_number: "T02", title: "Verify", controller_stage: "verify", depends_on: ["T01"] },
      { task_number: "T03", title: "Integrate", controller_stage: "integrate", depends_on: ["T02"] },
    ]);
    db.prepare("UPDATE tasks SET status = 'done' WHERE task_number IN ('T01', 'T02') AND directive_id = ?").run(directive.id);
    reconcileControllerDirective(createCtx(db, ws), directive.id);
    reconcileControllerDirective(createCtx(db, ws), directive.id);
    db.prepare("UPDATE tasks SET status = 'done', result = ? WHERE task_number = 'T03' AND directive_id = ?").run("Final summary", directive.id);

    const completed = reconcileControllerDirective(createCtx(db, ws), directive.id);
    const completedAt = completed?.completed_at;
    const second = reconcileControllerDirective(createCtx(db, ws), directive.id);

    assert.equal(completed?.status, "completed");
    assert.equal(completed?.controller_stage, "completed");
    assert.match(completed?.aggregated_result ?? "", /Final summary/);
    assert.equal(second?.status, "completed");
    assert.equal(second?.controller_stage, "completed");
    assert.equal(second?.aggregated_result, completed?.aggregated_result);
    assert.equal(second?.completed_at, completedAt);
  });
});
