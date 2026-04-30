import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import type { Directive } from "../types/runtime.js";
import {
  isControllerStage,
  isControllerTaskStartable,
  reconcileControllerDirective,
  splitDirectiveIntoControllerTasks,
  summarizeControllerDirective,
} from "./orchestrator.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('enable_controller_mode', 'true', ?)")
    .run(Date.now());
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
  it("splits a directive into staged worker tasks with write_scope and dependencies", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);

    const result = splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      {
        task_number: "T01",
        title: "Implement API",
        controller_stage: "implement",
        write_scope: ["server/routes/directives.ts"],
      },
      {
        task_number: "T02",
        title: "Verify API",
        controller_stage: "verify",
        depends_on: ["T01"],
      },
      {
        task_number: "T03",
        title: "Integrate result",
        controller_stage: "integrate",
        depends_on: ["T02"],
      },
    ]);

    assert.equal(result.directive.controller_mode, 1);
    assert.equal(result.directive.status, "active");
    assert.equal(result.directive.controller_stage, "implement");
    assert.equal(result.tasks.length, 3);
    assert.deepStrictEqual(JSON.parse(result.tasks[0].write_scope ?? "[]"), ["server/routes/directives.ts"]);
    assert.equal(result.tasks[1].depends_on, '["T01"]');
    assert.ok(ws.sent.some((entry) => entry.type === "directive_update"));
    assert.equal(ws.sent.filter((entry) => entry.type === "task_update").length, 3);
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

  it("rejects splits that contain duplicate task_numbers", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);

    assert.throws(
      () =>
        splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
          { task_number: "T01", title: "A", controller_stage: "implement" },
          { task_number: "T01", title: "B", controller_stage: "verify" },
        ]),
      /Duplicate task_number/,
    );

    const created = db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
    assert.equal(created.n, 0);
  });

  it("rejects splits whose depends_on points at a non-existent task_number", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);

    assert.throws(
      () =>
        splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
          { task_number: "T01", title: "A", controller_stage: "implement" },
          {
            task_number: "T02",
            title: "B",
            controller_stage: "verify",
            depends_on: ["T99"],
          },
        ]),
      /depends_on unknown task_number: T99/,
    );

    const created = db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
    assert.equal(created.n, 0);
  });

  it("allows split with serial implement children that share a write_scope file", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);

    const result = splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      {
        task_number: "T01",
        title: "A",
        controller_stage: "implement",
        write_scope: ["server/shared.ts"],
      },
      {
        task_number: "T02",
        title: "B",
        controller_stage: "implement",
        write_scope: ["server/shared.ts"],
        depends_on: ["T01"],
      },
    ]);
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[1].depends_on, '["T01"]');
  });

  it("normalizes write_scope (dedup, trim, sort) before persisting", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);

    const result = splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      {
        task_number: "T01",
        title: "Implement",
        controller_stage: "implement",
        write_scope: [" server/b.ts ", "server/a.ts", "server/a.ts", ""],
      },
    ]);

    assert.deepStrictEqual(JSON.parse(result.tasks[0].write_scope ?? "[]"), [
      "server/a.ts",
      "server/b.ts",
    ]);
  });

  it("isControllerTaskStartable returns true for non-controller tasks (no directive_id / no stage)", () => {
    const db = createDb();
    const taskWithoutDirective = {
      directive_id: null,
      controller_stage: null,
    } as never;
    assert.equal(isControllerTaskStartable(db, taskWithoutDirective), true);

    const directive = insertDirective(db, { id: "d-non-ctrl", controller_mode: 0 });
    const taskOnNonControllerDirective = {
      directive_id: directive.id,
      controller_stage: "implement",
    } as never;
    assert.equal(isControllerTaskStartable(db, taskOnNonControllerDirective), true);
  });

  it("reconcileControllerDirective is a no-op for missing / completed / cancelled directives", () => {
    const db = createDb();
    const ws = createWs();

    assert.equal(reconcileControllerDirective(createCtx(db, ws), "missing-id"), undefined);

    const completed = insertDirective(db, {
      id: "d-completed",
      controller_mode: 1,
      status: "completed",
      controller_stage: "completed",
    });
    const result = reconcileControllerDirective(createCtx(db, ws), completed.id);
    assert.equal(result?.id, completed.id);
    assert.equal(result?.status, "completed");
    // No update broadcast should fire for a terminal directive.
    assert.equal(ws.sent.length, 0);
  });

  it("reconcileControllerDirective is a no-op when no controller tasks exist yet", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db, { controller_mode: 1, status: "pending" });

    const result = reconcileControllerDirective(createCtx(db, ws), directive.id);

    assert.equal(result?.id, directive.id);
    assert.equal(result?.status, "pending");
    assert.equal(ws.sent.length, 0);
  });

  it("isControllerStage validates the public stage names", () => {
    assert.equal(isControllerStage("implement"), true);
    assert.equal(isControllerStage("verify"), true);
    assert.equal(isControllerStage("integrate"), true);
    assert.equal(isControllerStage("blocked"), false);
    assert.equal(isControllerStage("completed"), false);
    assert.equal(isControllerStage("unknown"), false);
  });

  it("summarizeControllerDirective groups tasks by stage", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);
    splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      { task_number: "T01", title: "Impl A", controller_stage: "implement" },
      { task_number: "T02", title: "Impl B", controller_stage: "implement" },
      { task_number: "T03", title: "Verify", controller_stage: "verify", depends_on: ["T01", "T02"] },
      { task_number: "T04", title: "Integrate", controller_stage: "integrate", depends_on: ["T03"] },
    ]);

    const summary = summarizeControllerDirective(db, directive.id);

    assert.equal(summary.directive?.id, directive.id);
    assert.equal(summary.tasks.length, 4);
    assert.equal(summary.stages.implement.length, 2);
    assert.equal(summary.stages.verify.length, 1);
    assert.equal(summary.stages.integrate.length, 1);
    assert.equal(summary.stages.implement[0].task_number, "T01");
  });

  it("summarizeControllerDirective returns empty stages for an unknown directive", () => {
    const db = createDb();
    const summary = summarizeControllerDirective(db, "missing");
    assert.equal(summary.directive, undefined);
    assert.equal(summary.tasks.length, 0);
    assert.deepStrictEqual(
      [summary.stages.implement.length, summary.stages.verify.length, summary.stages.integrate.length],
      [0, 0, 0],
    );
  });

  it("does not regress controller_stage when re-reconciled at the same stage", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);
    splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      { task_number: "T01", title: "A", controller_stage: "implement" },
      { task_number: "T02", title: "B", controller_stage: "implement" },
      { task_number: "T03", title: "Verify", controller_stage: "verify", depends_on: ["T01", "T02"] },
    ]);

    // Only one of two implement tasks done => still in implement.
    db.prepare("UPDATE tasks SET status = 'done' WHERE task_number = 'T01' AND directive_id = ?").run(directive.id);
    const stillImplement = reconcileControllerDirective(createCtx(db, ws), directive.id);
    assert.equal(stillImplement?.controller_stage, "implement");

    db.prepare("UPDATE tasks SET status = 'done' WHERE task_number = 'T02' AND directive_id = ?").run(directive.id);
    const advanced = reconcileControllerDirective(createCtx(db, ws), directive.id);
    assert.equal(advanced?.controller_stage, "verify");
  });

  it("skips missing stages when advancing (implement -> integrate when no verify exists)", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);
    splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      { task_number: "T01", title: "Impl", controller_stage: "implement" },
      { task_number: "T02", title: "Integrate", controller_stage: "integrate", depends_on: ["T01"] },
    ]);

    db.prepare("UPDATE tasks SET status = 'done' WHERE task_number = 'T01' AND directive_id = ?").run(directive.id);
    const advanced = reconcileControllerDirective(createCtx(db, ws), directive.id);
    assert.equal(advanced?.controller_stage, "integrate");
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

  it("creates at most one integrate child after verify completes before directive completion", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);
    splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      { task_number: "T01", title: "Implement A", controller_stage: "implement" },
      { task_number: "T02", title: "Verify", controller_stage: "verify", depends_on: ["T01"] },
    ]);
    db.prepare("UPDATE tasks SET status = 'done' WHERE task_number IN ('T01', 'T02') AND directive_id = ?").run(directive.id);

    const openedVerify = reconcileControllerDirective(createCtx(db, ws), directive.id);
    const first = reconcileControllerDirective(createCtx(db, ws), directive.id);
    const second = reconcileControllerDirective(createCtx(db, ws), directive.id);
    const integrateRows = db.prepare(
      "SELECT id, status, task_number, depends_on FROM tasks WHERE directive_id = ? AND controller_stage = 'integrate'",
    ).all(directive.id) as Array<{ id: string; status: string; task_number: string; depends_on: string | null }>;

    assert.equal(openedVerify?.controller_stage, "verify");
    assert.equal(first?.status, "active");
    assert.equal(first?.controller_stage, "integrate");
    assert.equal(second?.status, "active");
    assert.equal(integrateRows.length, 1);
    assert.equal(integrateRows[0].status, "inbox");
    assert.equal(integrateRows[0].depends_on, '["T02"]');

    db.prepare("UPDATE tasks SET status = 'done', result = ? WHERE id = ?").run("Integrated result", integrateRows[0].id);
    const completed = reconcileControllerDirective(createCtx(db, ws), directive.id);
    assert.equal(completed?.status, "completed");
    assert.match(completed?.aggregated_result ?? "", /Integrated result/);
  });

  it("creates an integrate child after implement completes when verify stage is absent", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db);
    splitDirectiveIntoControllerTasks(createCtx(db, ws), directive, [
      { task_number: "T01", title: "Implement A", controller_stage: "implement" },
      { task_number: "T02", title: "Implement B", controller_stage: "implement" },
    ]);
    db.prepare("UPDATE tasks SET status = 'done' WHERE directive_id = ?").run(directive.id);

    const advanced = reconcileControllerDirective(createCtx(db, ws), directive.id);
    const integrateRows = db.prepare(
      "SELECT status, task_number, depends_on FROM tasks WHERE directive_id = ? AND controller_stage = 'integrate'",
    ).all(directive.id) as Array<{ status: string; task_number: string; depends_on: string | null }>;

    assert.equal(advanced?.status, "active");
    assert.equal(advanced?.controller_stage, "integrate");
    assert.equal(integrateRows.length, 1);
    assert.equal(integrateRows[0].depends_on, '["T01","T02"]');
  });

  it("overwrites aggregated_result when a new successful integrate result is reconciled", () => {
    const db = createDb();
    const ws = createWs();
    const directive = insertDirective(db, {
      controller_mode: 1,
      status: "active",
      controller_stage: "integrate",
      aggregated_result: "Old result",
    });
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (
         id, title, status, directive_id, task_number, controller_stage, result, created_at, updated_at
       ) VALUES ('integrate-task', 'Integrate', 'done', ?, 'T01', 'integrate', 'New result', ?, ?)`,
    ).run(directive.id, now, now);

    const completed = reconcileControllerDirective(createCtx(db, ws), directive.id);

    assert.equal(completed?.status, "completed");
    assert.match(completed?.aggregated_result ?? "", /New result/);
    assert.doesNotMatch(completed?.aggregated_result ?? "", /Old result/);
  });
});
