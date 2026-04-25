import type { Agent, Directive, Task, TaskSummary } from "../types/index.js";

type EntityWithId = { id: string };
type ReviewStatus = Extract<TaskSummary["status"], "pr_review">;

export interface ReviewTransition {
  taskId: string;
  title: string;
  from: Task["status"];
  to: ReviewStatus;
}

export function mergeEntityUpdate<T extends EntityWithId>(
  entities: T[],
  update: Partial<T> & { id: string },
): { next: T[]; found: boolean } {
  let found = false;

  const next = entities.map((entity) => {
    if (entity.id !== update.id) {
      return entity;
    }

    found = true;
    return { ...entity, ...update };
  });

  return { next, found };
}

export function mergeTaskUpdate(tasks: TaskSummary[], update: Partial<TaskSummary> & { id: string }) {
  return mergeEntityUpdate(tasks, update);
}

export function mergeAgentUpdate(agents: Agent[], update: Partial<Agent> & { id: string }) {
  return mergeEntityUpdate(agents, update);
}

export function mergeDirectiveUpdate(directives: Directive[], update: Partial<Directive> & { id: string }) {
  return mergeEntityUpdate(directives, update);
}

function isReviewStatus(status: Task["status"]): status is ReviewStatus {
  return status === "pr_review";
}

export function collectReviewTransitions(previousTasks: TaskSummary[], nextTasks: TaskSummary[]): ReviewTransition[] {
  const previousById = new Map(previousTasks.map((task) => [task.id, task]));

  return nextTasks.flatMap((task) => {
    const previousTask = previousById.get(task.id);
    if (!previousTask) {
      return [];
    }
    if (previousTask.status === task.status) {
      return [];
    }
    if (!isReviewStatus(task.status)) {
      return [];
    }

    return [{
      taskId: task.id,
      title: task.title,
      from: previousTask.status,
      to: task.status,
    }];
  });
}
