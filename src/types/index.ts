export interface Agent {
  id: string;
  name: string;
  cli_provider: "claude" | "codex" | "gemini";
  cli_model: string | null;
  cli_reasoning_level: string | null;
  avatar_emoji: string;
  role: string | null;
  personality: string | null;
  status: "idle" | "working" | "offline";
  current_task_id: string | null;
  stats_tasks_done: number;
  created_at: number;
  updated_at: number;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  assigned_agent_id: string | null;
  project_path: string | null;
  status: "inbox" | "in_progress" | "self_review" | "pr_review" | "done" | "cancelled";
  priority: number;
  task_size: "small" | "medium" | "large";
  result: string | null;
  review_count: number;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TaskLog {
  id: number;
  task_id: string;
  kind: "stdout" | "stderr" | "system" | "thinking" | "assistant" | "tool_call" | "tool_result";
  message: string;
  created_at: number;
}

export interface Message {
  id: string;
  sender_type: "user" | "agent" | "system";
  sender_id: string | null;
  content: string;
  message_type: string;
  task_id: string | null;
  created_at: number;
}

export type WSEventType =
  | "task_update"
  | "agent_status"
  | "cli_output"
  | "subtask_update"
  | "message_new";

export interface WSEvent {
  type: WSEventType;
  payload: unknown;
  ts: number;
}

export type Settings = Record<string, string>;
export type CliStatus = Record<string, boolean>;
