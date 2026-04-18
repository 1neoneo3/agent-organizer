import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { CacheService } from "../cache/cache-service.js";
import type { TaskStatus } from "../domain/task-status.js";

export interface RuntimeContext {
  db: DatabaseSync;
  ws: WsHub;
  cache: CacheService;
}

export interface Agent {
  id: string;
  name: string;
  cli_provider: "claude" | "codex" | "gemini";
  cli_model: string | null;
  cli_reasoning_level: string | null;
  avatar_emoji: string;
  role: string | null;
  agent_type: "worker" | "ceo";
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
  status: TaskStatus;
  priority: number;
  task_size: "small" | "medium" | "large";
  task_number: string | null;
  depends_on: string | null;
  result: string | null;
  refinement_plan: string | null;
  refinement_completed_at: number | null;
  planned_files: string | null;
  pr_url: string | null;
  external_source: string | null;
  external_id: string | null;
  review_count: number;
  directive_id: string | null;
  interactive_prompt_data: string | null;
  review_branch: string | null;
  review_commit_sha: string | null;
  review_sync_status: "pending" | "not_applicable" | "local_commit_ready" | "pushed" | "pr_open";
  review_sync_error: string | null;
  repository_url: string | null;
  repository_urls: string | null;
  pr_urls: string | null;
  started_at: number | null;
  completed_at: number | null;
  auto_respawn_count: number;
  created_at: number;
  updated_at: number;
}

export interface Directive {
  id: string;
  title: string;
  content: string;
  issued_by_type: "user" | "agent";
  issued_by_id: string | null;
  status: "pending" | "decomposing" | "active" | "completed" | "cancelled";
  project_path: string | null;
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

export type TaskLogKind =
  | "stdout"
  | "stderr"
  | "system"
  | "thinking"
  | "assistant"
  | "tool_call"
  | "tool_result";

export interface TaskLog {
  id: number;
  task_id: string;
  kind: TaskLogKind;
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
