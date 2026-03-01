import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";

export interface RuntimeContext {
  db: DatabaseSync;
  ws: WsHub;
}

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

export interface Subtask {
  id: string;
  task_id: string;
  title: string;
  description: string | null;
  status: "pending" | "in_progress" | "done" | "blocked";
  assigned_agent_id: string | null;
  blocked_reason: string | null;
  cli_tool_use_id: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface TaskLog {
  id: number;
  task_id: string;
  kind: "stdout" | "stderr" | "system";
  message: string;
  created_at: number;
}

export interface Message {
  id: string;
  sender_type: "user" | "agent" | "system";
  sender_id: string | null;
  content: string;
  message_type: "chat" | "task_assign" | "directive" | "report" | "status_update";
  task_id: string | null;
  created_at: number;
}
