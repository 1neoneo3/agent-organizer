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
export const createTask = (data: Partial<Task>) => api.post<Task>("/tasks", data);
export const updateTask = (id: string, data: Partial<Task>) => api.put<Task>(`/tasks/${id}`, data);
export const deleteTask = (id: string) => api.delete<{ deleted: boolean }>(`/tasks/${id}`);
export const runTask = (id: string, agentId?: string) =>
  api.post<{ started: boolean; pid: number }>(`/tasks/${id}/run`, agentId ? { agent_id: agentId } : {});
export const stopTask = (id: string) => api.post<{ stopped: boolean }>(`/tasks/${id}/stop`);
export const fetchTaskLogs = (id: string, limit = 200) =>
  api.get<TaskLog[]>(`/tasks/${id}/logs?limit=${limit}`);

export interface TerminalResponse {
  ok: boolean;
  exists: boolean;
  text: string;
  task_logs: Array<{ kind: string; message: string; created_at: number }>;
}

export const fetchTerminal = (id: string, lines = 2000, pretty = true) =>
  api.get<TerminalResponse>(`/tasks/${id}/terminal?lines=${lines}&pretty=${pretty ? "1" : "0"}`);

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

// CLI Status
export const fetchCliStatus = () => api.get<CliStatus>("/cli-status");
