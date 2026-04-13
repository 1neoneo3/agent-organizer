import { TASK_STATUSES, buildSqlCheckIn } from "../domain/task-status.js";

const TASK_STATUS_CHECK = buildSqlCheckIn("status", TASK_STATUSES);

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  cli_provider TEXT NOT NULL DEFAULT 'claude' CHECK(cli_provider IN ('claude','codex','gemini')),
  cli_model TEXT,
  cli_reasoning_level TEXT,
  avatar_emoji TEXT DEFAULT '🤖',
  role TEXT,
  agent_type TEXT NOT NULL DEFAULT 'worker' CHECK(agent_type IN ('worker','ceo')),
  personality TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','working','offline')),
  current_task_id TEXT,
  stats_tasks_done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_path TEXT NOT NULL UNIQUE,
  core_goal TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  project_path TEXT,
  status TEXT NOT NULL DEFAULT 'inbox' ${TASK_STATUS_CHECK},
  priority INTEGER NOT NULL DEFAULT 0,
  task_size TEXT NOT NULL DEFAULT 'small' CHECK(task_size IN ('small','medium','large')),
  task_number TEXT,
  depends_on TEXT,
  result TEXT,
  refinement_plan TEXT,
  review_count INTEGER NOT NULL DEFAULT 0,
  directive_id TEXT REFERENCES directives(id) ON DELETE SET NULL,
  pr_url TEXT,
  external_source TEXT,
  external_id TEXT,
  interactive_prompt_data TEXT,
  review_branch TEXT,
  review_commit_sha TEXT,
  review_sync_status TEXT NOT NULL DEFAULT 'pending',
  review_sync_error TEXT,
  repository_url TEXT,
  repository_urls TEXT,
  pr_urls TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  last_heartbeat_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','blocked')),
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  blocked_reason TEXT,
  cli_tool_use_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'stdout' CHECK(kind IN ('stdout','stderr','system','thinking','assistant','tool_call','tool_result')),
  message TEXT NOT NULL,
  stage TEXT,
  agent_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user','agent','system')),
  sender_id TEXT,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'chat' CHECK(message_type IN ('chat','task_assign','directive','report','status_update')),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS directives (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  issued_by_type TEXT NOT NULL DEFAULT 'user' CHECK(issued_by_type IN ('user','agent')),
  issued_by_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','decomposing','active','completed','cancelled')),
  project_path TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

CREATE INDEX IF NOT EXISTS idx_directives_status ON directives(status);

CREATE TABLE IF NOT EXISTS api_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('openai','anthropic','google','ollama','openrouter','custom')),
  base_url TEXT,
  api_key_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority_created ON tasks(status, priority DESC, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_ref ON tasks(external_source, external_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at);
`;
