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

export type TaskStatus = "inbox" | "refinement" | "in_progress" | "test_generation" | "qa_testing" | "pr_review" | "human_review" | "done" | "cancelled";

export interface TaskSummary {
  id: string;
  title: string;
  assigned_agent_id: string | null;
  project_path: string | null;
  status: TaskStatus;
  priority: number;
  task_size: "small" | "medium" | "large";
  task_number: string | null;
  depends_on: string | null;
  controller_stage?: "implement" | "verify" | "integrate" | null;
  refinement_completed_at?: number | null;
  refinement_revision_requested_at?: number | null;
  refinement_revision_completed_at?: number | null;
  review_count: number;
  directive_id: string | null;
  pr_url: string | null;
  external_source: string | null;
  external_id: string | null;
  review_branch: string | null;
  review_commit_sha: string | null;
  review_sync_status: string | null;
  review_sync_error: string | null;
  repository_url: string | null;
  settings_overrides: string | null;
  started_at: number | null;
  completed_at: number | null;
  last_heartbeat_at: number | null;
  auto_respawn_count: number;
  created_at: number;
  updated_at: number;

  // Server-derived summary fields. Populated by the GET /tasks handler
  // and the WebSocket task_update broadcast (see
  // server/domain/task-derived-fields.ts). Lets the kanban render
  // parent/child relationships and "has plan" state without fetching
  // the heavy description / result / refinement_plan columns.
  parent_task_number: string | null;
  child_task_numbers: string[] | null;
  has_refinement_plan: boolean;
}

export interface Task extends TaskSummary {
  description: string | null;
  result: string | null;
  refinement_plan: string | null;
  planned_files: string | null;
  interactive_prompt_data: string | null;
  repository_urls: string | null;
  pr_urls: string | null;
  merged_pr_urls: string | null;
}

export interface TaskLog {
  id: number;
  task_id: string;
  kind: "stdout" | "stderr" | "system" | "thinking" | "assistant" | "tool_call" | "tool_result";
  message: string;
  stage: string | null;
  agent_id: string | null;
  created_at: number;
  pending?: boolean;
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

export interface Directive {
  id: string;
  title: string;
  content: string;
  issued_by_type: "user" | "agent";
  issued_by_id: string | null;
  status: "pending" | "decomposing" | "active" | "completed" | "cancelled";
  project_path: string | null;
  controller_mode?: number;
  controller_stage?: "implement" | "verify" | "integrate" | "blocked" | "completed" | null;
  aggregated_result?: string | null;
  completed_at?: number | null;
  created_at: number;
  updated_at: number;
}

export interface InteractivePrompt {
  task_id: string;
  promptType: "exit_plan_mode" | "ask_user_question" | "text_input_request";
  toolUseId: string;
  /** The raw assistant text that triggered text_input_request detection */
  detectedText?: string;
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string; markdown?: string }>;
    multiSelect?: boolean;
  }>;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
}

export type WSEventType =
  | "task_update"
  | "agent_status"
  | "cli_output"
  | "subtask_update"
  | "message_new"
  | "directive_update"
  | "decompose_output"
  | "interactive_prompt"
  | "interactive_prompt_resolved";

export interface WSEvent {
  type: WSEventType;
  payload: unknown;
  ts: number;
}

export type Settings = Record<string, string>;
export type CliStatus = Record<string, boolean>;
