import type { Agent, Directive, Task } from "../types/index.js";

type EntityWithId = { id: string };

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

export function mergeTaskUpdate(tasks: Task[], update: Partial<Task> & { id: string }) {
  return mergeEntityUpdate(tasks, update);
}

export function mergeAgentUpdate(agents: Agent[], update: Partial<Agent> & { id: string }) {
  return mergeEntityUpdate(agents, update);
}

export function mergeDirectiveUpdate(directives: Directive[], update: Partial<Directive> & { id: string }) {
  return mergeEntityUpdate(directives, update);
}
