import type { DatabaseSync } from "node:sqlite";
import type { Directive, Task } from "../types/runtime.js";

export interface ParentTaskRef {
  id: string;
  task_number: string | null;
  title: string;
}

export function fetchControllerParentsByDirectiveIds(
  db: DatabaseSync,
  directiveIds: string[],
): Map<string, ParentTaskRef> {
  const out = new Map<string, ParentTaskRef>();
  const uniqueIds = Array.from(new Set(directiveIds.filter(Boolean)));
  if (uniqueIds.length === 0) return out;

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const byParentId = db.prepare(
    `SELECT child.directive_id, parent.id, parent.task_number, parent.title
     FROM tasks child
     JOIN tasks parent ON parent.id = child.parent_task_id
     WHERE child.directive_id IN (${placeholders})
       AND child.parent_task_id IS NOT NULL
     ORDER BY child.created_at ASC`,
  ).all(...uniqueIds) as unknown as Array<ParentTaskRef & { directive_id: string }>;
  for (const row of byParentId) {
    if (!out.has(row.directive_id)) out.set(row.directive_id, row);
  }

  const unresolved = uniqueIds.filter((id) => !out.has(id));
  if (unresolved.length === 0) return out;

  const unresolvedPlaceholders = unresolved.map(() => "?").join(", ");
  const byParentNumber = db.prepare(
    `SELECT child.directive_id, parent.id, parent.task_number, parent.title
     FROM tasks child
     JOIN tasks parent ON parent.task_number = child.parent_task_number
     WHERE child.directive_id IN (${unresolvedPlaceholders})
       AND child.parent_task_number IS NOT NULL
     ORDER BY child.created_at ASC,
              CASE WHEN parent.status = 'cancelled' THEN 1 ELSE 0 END,
              parent.created_at DESC`,
  ).all(...unresolved) as unknown as Array<ParentTaskRef & { directive_id: string }>;
  for (const row of byParentNumber) {
    if (!out.has(row.directive_id)) out.set(row.directive_id, row);
  }

  return out;
}

export function inferControllerParentForTask(
  db: DatabaseSync,
  task: Pick<Task, "controller_stage" | "directive_id" | "parent_task_id" | "parent_task_number">,
): ParentTaskRef | null {
  if (task.controller_stage !== "integrate" || !task.directive_id) return null;
  if (task.parent_task_id || task.parent_task_number) return null;
  return fetchControllerParentsByDirectiveIds(db, [task.directive_id]).get(task.directive_id) ?? null;
}

export function findControllerParentTask(
  db: DatabaseSync,
  directive: Directive,
  tasks: readonly Task[],
): ParentTaskRef | null {
  const childWithParentId = tasks.find((task) => task.parent_task_id);
  if (childWithParentId?.parent_task_id) {
    const parent = db.prepare("SELECT id, task_number, title FROM tasks WHERE id = ?")
      .get(childWithParentId.parent_task_id) as ParentTaskRef | undefined;
    if (parent) return parent;
  }

  const childWithParentNumber = tasks.find((task) => task.parent_task_number);
  if (childWithParentNumber?.parent_task_number) {
    const parent = db.prepare(
      "SELECT id, task_number, title FROM tasks WHERE task_number = ? ORDER BY CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END, created_at DESC LIMIT 1",
    ).get(childWithParentNumber.parent_task_number) as ParentTaskRef | undefined;
    if (parent) return parent;
  }

  const m = directive.title.match(/^Controller:\s+((?:#[0-9]+|[A-Z]+[0-9]+))\s+(.+)$/);
  if (!m) return null;
  const parent = db.prepare(
    "SELECT id, task_number, title FROM tasks WHERE task_number = ? ORDER BY CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END, created_at DESC LIMIT 1",
  ).get(m[1]) as ParentTaskRef | undefined;
  return parent ?? null;
}

export function formatIntegrateTaskTitle(parent: ParentTaskRef | null): string {
  if (!parent) return "Integrate controller results";
  const parentLabel = parent.task_number ? `${parent.task_number} ${parent.title}` : parent.title;
  return `Integrate controller results: ${parentLabel}`;
}
