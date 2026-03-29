export type ExamplePriority = "low" | "medium" | "high";

export interface ExampleTask {
  id: number;
  title: string;
  completed: boolean;
  priority: ExamplePriority;
  tags: readonly string[];
}

export interface BuildExampleTaskInput {
  id: number;
  title: string;
  priority: ExamplePriority;
  completed?: boolean;
  tags?: readonly string[];
}

export interface ExampleTaskSummary {
  total: number;
  completedCount: number;
  pendingTitles: string[];
}

export function buildExampleTask(input: BuildExampleTaskInput): ExampleTask {
  return {
    id: input.id,
    title: input.title,
    completed: input.completed ?? false,
    priority: input.priority,
    tags: [...(input.tags ?? [])],
  };
}

export function getPriorityLabel(priority: ExamplePriority): string {
  switch (priority) {
    case "low":
      return "Low Priority";
    case "medium":
      return "Medium Priority";
    case "high":
      return "High Priority";
    default: {
      const unreachable: never = priority;
      return unreachable;
    }
  }
}

export function summarizeExampleTasks(tasks: readonly ExampleTask[]): ExampleTaskSummary {
  const pendingTitles = tasks
    .filter((task) => !task.completed)
    .map((task) => task.title);

  return {
    total: tasks.length,
    completedCount: tasks.filter((task) => task.completed).length,
    pendingTitles,
  };
}
