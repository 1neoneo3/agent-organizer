import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeContext, Directive, Task } from "../types/runtime.js";
import { buildTaskSummaryUpdate } from "../ws/update-payloads.js";

export const CONTROLLER_STAGES = ["implement", "verify", "integrate"] as const;
export type ControllerStage = (typeof CONTROLLER_STAGES)[number];

export interface ControllerChildInput {
  task_number: string;
  title: string;
  description?: string | null;
  controller_stage: ControllerStage;
  write_scope?: string[];
  depends_on?: string[];
  priority?: number;
  task_size?: "small" | "medium" | "large";
}

export interface ControllerSplitResult {
  directive: Directive;
  tasks: Task[];
}

export interface ControllerAdvanceResult {
  directive: Directive | undefined;
  advanced: boolean;
  blocked_reason?: string;
  created_integrate_task?: Task;
}

function nowMs(): number {
  return Date.now();
}

export function isControllerStage(value: string): value is ControllerStage {
  return (CONTROLLER_STAGES as readonly string[]).includes(value);
}

function normalizeScope(scope: readonly string[] | undefined): string[] {
  return [...new Set((scope ?? []).map((item) => item.trim()).filter(Boolean))].sort();
}

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function isControllerModeEnabled(db: DatabaseSync): boolean {
  return getSetting(db, "enable_controller_mode") === "true";
}

function firstStageWithTasks(tasks: readonly { controller_stage?: ControllerStage | null }[]): ControllerStage | null {
  return CONTROLLER_STAGES.find((stage) => tasks.some((task) => task.controller_stage === stage)) ?? null;
}

function nextStageWithTasks(
  currentStage: ControllerStage,
  tasks: readonly { controller_stage?: ControllerStage | null }[],
): ControllerStage | null {
  const currentIndex = CONTROLLER_STAGES.indexOf(currentStage);
  return CONTROLLER_STAGES
    .slice(currentIndex + 1)
    .find((stage) => tasks.some((task) => task.controller_stage === stage)) ?? null;
}

function fetchDirective(db: DatabaseSync, directiveId: string): Directive | undefined {
  return db.prepare("SELECT * FROM directives WHERE id = ?").get(directiveId) as Directive | undefined;
}

function fetchControllerTasks(db: DatabaseSync, directiveId: string): Task[] {
  return db.prepare(
    "SELECT * FROM tasks WHERE directive_id = ? AND controller_stage IS NOT NULL ORDER BY created_at ASC",
  ).all(directiveId) as unknown as Task[];
}

function stageTasks(tasks: readonly Task[], stage: ControllerStage): Task[] {
  return tasks.filter((task) => task.controller_stage === stage);
}

function buildAggregatedResult(tasks: readonly Task[]): string {
  const sections = tasks
    .filter((task) => task.controller_stage === "integrate")
    .map((task) => {
      const title = task.task_number ? `${task.task_number} ${task.title}` : task.title;
      return `## ${title}\n\n${task.result?.trim() || "(no result)"}`;
    });
  return sections.join("\n\n").trim();
}

function nextGeneratedTaskNumber(tasks: readonly Task[]): string {
  const used = new Set(tasks.map((task) => task.task_number).filter((value): value is string => Boolean(value)));
  for (let i = tasks.length + 1; i <= tasks.length + 100; i++) {
    const candidate = `T${String(i).padStart(2, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  return `T${Date.now()}`;
}

function createIntegrateChild(ctx: RuntimeContext, directive: Directive, tasks: readonly Task[]): Task {
  const existing = tasks.find((task) => task.controller_stage === "integrate");
  if (existing) return existing;

  const dependencyStage = tasks.some((task) => task.controller_stage === "verify") ? "verify" : "implement";
  const dependencyTaskNumbers = tasks
    .filter((task) => task.controller_stage === dependencyStage && task.task_number)
    .map((task) => task.task_number as string);
  const dependsOnJson = dependencyTaskNumbers.length > 0 ? JSON.stringify([...new Set(dependencyTaskNumbers)]) : null;
  const now = nowMs();
  const id = randomUUID();
  ctx.db.prepare(
    `INSERT INTO tasks (
       id, title, description, project_path, status, priority, task_size,
       directive_id, task_number, depends_on, controller_stage,
       write_scope, planned_files, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'inbox', 0, 'small', ?, ?, ?, 'integrate', NULL, NULL, ?, ?)`,
  ).run(
    id,
    "Integrate controller results",
    "Aggregate completed controller child results and produce the final directive result.",
    directive.project_path,
    directive.id,
    nextGeneratedTaskNumber(tasks),
    dependsOnJson,
    now,
    now,
  );
  const task = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task;
  ctx.ws.broadcast("task_update", buildTaskSummaryUpdate(task));
  return task;
}

function updateDirectiveStage(
  ctx: RuntimeContext,
  directive: Directive,
  stage: ControllerStage | "blocked" | "completed",
  extra: { status?: Directive["status"]; aggregatedResult?: string | null; completedAt?: number | null } = {},
): Directive {
  const now = nowMs();
  const nextStatus = extra.status ?? directive.status;
  dbUpdateDirective(ctx.db, {
    id: directive.id,
    status: nextStatus,
    controller_stage: stage,
    aggregated_result: extra.aggregatedResult,
    completed_at: extra.completedAt,
    updated_at: now,
  });
  const updated = fetchDirective(ctx.db, directive.id)!;
  ctx.ws.broadcast("directive_update", updated);
  return updated;
}

function dbUpdateDirective(
  db: DatabaseSync,
  values: {
    id: string;
    status: Directive["status"];
    controller_stage: ControllerStage | "blocked" | "completed";
    aggregated_result?: string | null;
    completed_at?: number | null;
    updated_at: number;
  },
): void {
  db.prepare(
    `UPDATE directives
     SET status = ?,
         controller_stage = ?,
         aggregated_result = CASE
           WHEN ? IS NULL THEN aggregated_result
           ELSE ?
         END,
         completed_at = COALESCE(completed_at, ?),
         updated_at = ?
     WHERE id = ?`,
  ).run(
    values.status,
    values.controller_stage,
    values.aggregated_result ?? null,
    values.aggregated_result ?? null,
    values.completed_at ?? null,
    values.updated_at,
    values.id,
  );
}

export function reconcileControllerDirective(ctx: RuntimeContext, directiveId: string): Directive | undefined {
  if (!isControllerModeEnabled(ctx.db)) {
    return fetchDirective(ctx.db, directiveId);
  }
  return advanceControllerDirective(ctx, directiveId).directive;
}

export function advanceControllerDirective(ctx: RuntimeContext, directiveId: string): ControllerAdvanceResult {
  const directive = fetchDirective(ctx.db, directiveId);
  if (
    !directive ||
    directive.controller_mode !== 1 ||
    directive.status === "cancelled" ||
    directive.status === "completed"
  ) {
    return {
      directive,
      advanced: false,
      blocked_reason: directive ? `directive is ${directive.status}` : "directive not found",
    };
  }

  const tasks = fetchControllerTasks(ctx.db, directiveId);
  if (tasks.length === 0) return { directive, advanced: false, blocked_reason: "no controller tasks exist" };

  if (tasks.some((task) => task.status === "cancelled")) {
    if (directive.controller_stage !== "blocked") {
      return { directive: updateDirectiveStage(ctx, directive, "blocked", { status: "active" }), advanced: true };
    }
    return { directive, advanced: false, blocked_reason: "one or more controller tasks are cancelled" };
  }

  const currentStage =
    directive.controller_stage && isControllerStage(directive.controller_stage)
      ? directive.controller_stage
      : firstStageWithTasks(tasks);
  if (!currentStage) return { directive, advanced: false, blocked_reason: "no current controller stage" };

  const currentStageTasks = stageTasks(tasks, currentStage);
  if (currentStageTasks.length === 0) {
    return { directive, advanced: false, blocked_reason: `no tasks exist for ${currentStage}` };
  }
  if (!currentStageTasks.every((task) => task.status === "done")) {
    if (directive.controller_stage !== currentStage || directive.status !== "active") {
      return { directive: updateDirectiveStage(ctx, directive, currentStage, { status: "active" }), advanced: true };
    }
    return {
      directive,
      advanced: false,
      blocked_reason: `${currentStage} stage has unfinished tasks`,
    };
  }

  if (currentStage === "integrate") {
    const aggregatedResult = buildAggregatedResult(tasks);
    return {
      directive: updateDirectiveStage(ctx, directive, "completed", {
        status: "completed",
        aggregatedResult,
        completedAt: nowMs(),
      }),
      advanced: true,
    };
  }

  const nextStage = nextStageWithTasks(currentStage, tasks);
  if (!nextStage && (currentStage === "implement" || currentStage === "verify")) {
    const integrateTask = createIntegrateChild(ctx, directive, tasks);
    return {
      directive: updateDirectiveStage(ctx, directive, "integrate", { status: "active" }),
      advanced: true,
      created_integrate_task: integrateTask,
    };
  }
  if (!nextStage) {
    return {
      directive,
      advanced: false,
      blocked_reason: "integrate stage is required before completion",
    };
  }

  return { directive: updateDirectiveStage(ctx, directive, nextStage, { status: "active" }), advanced: true };
}

export function isControllerTaskStartable(db: DatabaseSync, task: Task): boolean {
  if (!isControllerModeEnabled(db)) return true;
  if (!task.directive_id || !task.controller_stage) return true;
  const directive = fetchDirective(db, task.directive_id);
  if (!directive || directive.controller_mode !== 1) return true;
  return directive.status === "active" && directive.controller_stage === task.controller_stage;
}

export function splitDirectiveIntoControllerTasks(
  ctx: RuntimeContext,
  directive: Directive,
  children: readonly ControllerChildInput[],
): ControllerSplitResult {
  const seenTaskNumbers = new Set<string>();
  for (const child of children) {
    if (seenTaskNumbers.has(child.task_number)) {
      throw new Error(`Duplicate task_number in controller split: ${child.task_number}`);
    }
    seenTaskNumbers.add(child.task_number);
  }

  const validTaskNumbers = new Set(children.map((child) => child.task_number));
  for (const child of children) {
    const invalidDep = (child.depends_on ?? []).find((dep) => !validTaskNumbers.has(dep));
    if (invalidDep) {
      throw new Error(`${child.task_number} depends_on unknown task_number: ${invalidDep}`);
    }
  }

  const now = nowMs();
  const firstStage = firstStageWithTasks(children);
  const insertTask = ctx.db.prepare(
    `INSERT INTO tasks (
       id, title, description, project_path, status, priority, task_size,
       directive_id, task_number, depends_on, controller_stage,
       write_scope, planned_files, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const createdTasks: Task[] = [];
  for (const child of children) {
    const writeScope = normalizeScope(child.write_scope);
    const dependsOn = [...new Set(child.depends_on ?? [])];
    const writeScopeJson = writeScope.length > 0 ? JSON.stringify(writeScope) : null;
    const plannedFilesJson = child.controller_stage === "implement" ? writeScopeJson : null;
    const dependsOnJson = dependsOn.length > 0 ? JSON.stringify(dependsOn) : null;
    const id = randomUUID();
    insertTask.run(
      id,
      child.title,
      child.description ?? null,
      directive.project_path,
      child.priority ?? 0,
      child.task_size ?? "small",
      directive.id,
      child.task_number,
      dependsOnJson,
      child.controller_stage,
      writeScopeJson,
      plannedFilesJson,
      now,
      now,
    );
    const task = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task;
    createdTasks.push(task);
  }

  ctx.db.prepare(
    `UPDATE directives
     SET controller_mode = 1,
         controller_stage = ?,
         status = 'active',
         aggregated_result = NULL,
         completed_at = NULL,
         updated_at = ?
     WHERE id = ?`,
  ).run(firstStage, now, directive.id);

  const updatedDirective = fetchDirective(ctx.db, directive.id)!;
  ctx.ws.broadcast("directive_update", updatedDirective);
  for (const task of createdTasks) {
    ctx.ws.broadcast("task_update", buildTaskSummaryUpdate(task));
  }

  return { directive: updatedDirective, tasks: createdTasks };
}

export function summarizeControllerDirective(db: DatabaseSync, directiveId: string): {
  directive: Directive | undefined;
  tasks: Task[];
  stages: Record<ControllerStage, Task[]>;
} {
  const directive = fetchDirective(db, directiveId);
  const tasks = fetchControllerTasks(db, directiveId);
  return {
    directive,
    tasks,
    stages: {
      implement: stageTasks(tasks, "implement"),
      verify: stageTasks(tasks, "verify"),
      integrate: stageTasks(tasks, "integrate"),
    },
  };
}
