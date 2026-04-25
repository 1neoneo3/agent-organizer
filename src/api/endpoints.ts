import { api } from "./index.js";
import type { Agent, Task, TaskLog, Message, Settings, CliStatus, Directive } from "../types/index.js";

// Agents
export const fetchAgents = () => api.get<Agent[]>("/agents");
export const createAgent = (data: Partial<Agent>) => api.post<Agent>("/agents", data);
export const updateAgent = (id: string, data: Partial<Agent>) => api.put<Agent>(`/agents/${id}`, data);
export const deleteAgent = (id: string) => api.delete<{ deleted: boolean }>(`/agents/${id}`);

// Tasks
export const fetchTasks = (status?: string) =>
  api.get<Task[]>(status ? `/tasks?status=${status}` : "/tasks");
export const fetchTask = (id: string) => api.get<Task>(`/tasks/${id}`);
export const createTask = (data: Partial<Task>) => api.post<Task>("/tasks", data);
export const updateTask = (id: string, data: Partial<Task>) => api.put<Task>(`/tasks/${id}`, data);
export const deleteTask = (id: string) => api.delete<{ deleted: boolean }>(`/tasks/${id}`);
export const runTask = (id: string, agentId?: string) =>
  api.post<{ started: boolean; pid: number }>(`/tasks/${id}/run`, agentId ? { agent_id: agentId } : {});
export const stopTask = (id: string) => api.post<{ stopped: boolean }>(`/tasks/${id}/stop`);
export const resumeTask = (id: string, agentId?: string) =>
  api.post<{ resumed: boolean; pid: number }>(`/tasks/${id}/resume`, agentId ? { agent_id: agentId } : {});
export const approveTask = (id: string) => api.post<{ approved: boolean; next_status: string }>(`/tasks/${id}/approve`);
export const rejectTask = (id: string, reason?: string) => api.post<{ rejected: boolean; reason: string }>(`/tasks/${id}/reject`, { reason });
export const splitTask = (id: string) => api.post<{ parent: Task; children: Task[]; plan_path: string | null }>(`/tasks/${id}/split`);
export const toggleAcceptanceCriterion = (
  id: string,
  index: number,
  checked: boolean,
) =>
  api.patch<{ task: Task; index: number; checked: boolean; total: number }>(
    `/tasks/${id}/acceptance-criterion`,
    { index, checked },
  );
export const fetchTaskLogs = (
  id: string,
  limit = 200,
  sinceId?: number,
  offset = 0,
) => {
  const params: string[] = [`limit=${limit}`];
  if (sinceId != null) params.push(`since_id=${sinceId}`);
  if (offset > 0) params.push(`offset=${offset}`);
  return api.get<TaskLog[]>(`/tasks/${id}/logs?${params.join("&")}`);
};

// Messages
export const fetchMessages = (taskId?: string, limit = 50) =>
  api.get<Message[]>(taskId ? `/messages?task_id=${taskId}&limit=${limit}` : `/messages?limit=${limit}`);
export const sendMessage = (data: Partial<Message>) => api.post<Message>("/messages", data);

// Settings
export const fetchSettings = () => api.get<Settings>("/settings");
export const updateSettings = (data: Settings) => api.put<Settings>("/settings", data);

// Task Feedback
export const sendTaskFeedback = (taskId: string, content: string) =>
  api.post<{ sent: boolean; feedback_path: string }>(`/tasks/${taskId}/feedback`, { content });

// Directives
export const fetchDirectives = (status?: string) =>
  api.get<Directive[]>(status ? `/directives?status=${status}` : "/directives");
export const fetchDirective = (id: string) => api.get<Directive>(`/directives/${id}`);
export const createDirective = (data: { title: string; content: string; project_path?: string; auto_decompose?: boolean }) =>
  api.post<Directive>("/directives", data);
export const updateDirective = (id: string, data: Partial<Directive>) =>
  api.put<Directive>(`/directives/${id}`, data);
export const deleteDirective = (id: string) =>
  api.delete<{ deleted: boolean }>(`/directives/${id}`);
export const decomposeDirective = (id: string) =>
  api.post<{ started: boolean; directive_id: string }>(`/directives/${id}/decompose`);
export const fetchDirectiveTasks = (id: string) =>
  api.get<Task[]>(`/directives/${id}/tasks`);
export const fetchDirectivePlan = (id: string) =>
  api.get<{ directive_id: string; content: string }>(`/directives/${id}/plan`);

export interface DecomposeLogEntry {
  directive_id: string;
  kind: "stdout" | "stderr" | "system";
  message: string;
  ts: number;
}

export const fetchDecomposeLogs = (id: string) =>
  api.get<DecomposeLogEntry[]>(`/directives/${id}/decompose-logs`);

// Interactive Prompts (pending)
import type { InteractivePrompt } from "../types/index.js";
export const fetchInteractivePrompts = () =>
  api.get<InteractivePrompt[]>("/tasks/interactive-prompts");

// Interactive Prompt Response
export const sendInteractiveResponse = (
  taskId: string,
  payload: {
    promptType: "exit_plan_mode" | "ask_user_question" | "text_input_request";
    approved?: boolean;
    selectedOptions?: Record<string, string | string[]>;
    freeText?: string;
  }
) => api.post<{ sent: boolean; restarted: boolean }>(`/tasks/${taskId}/interactive-response`, payload);

// CLI Status
export const fetchCliStatus = () => api.get<CliStatus>("/cli-status");
export const fetchAgent = (id: string) => api.get<Agent>(`/agents/${id}`);
