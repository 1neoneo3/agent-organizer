import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.js";
import { DB_PATH, SETTINGS_DEFAULTS, DEFAULT_CLI_MODELS } from "../config/runtime.js";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error("Database not initialized. Call initializeDb() first.");
  return db;
}

export function initializeDb(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  migrateAddRoleColumn(db);
  migrateAddAgentType(db);
  migrateAddDirectiveId(db);
  migrateAddTaskNumbering(db);
  migrateAddInteractivePrompt(db);
  migrateAddPrUrl(db);
  migrateAddExternalTaskRef(db);
  migrateAddReviewArtifactFields(db);
  migrateAddQaTestingStatus(db);
  backfillTaskNumbers(db);
  seedDefaults(db);
  backfillCliModels(db);
  return db;
}

function migrateAddRoleColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "role")) {
    db.exec("ALTER TABLE agents ADD COLUMN role TEXT");
  }
}

function migrateAddAgentType(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "agent_type")) {
    db.exec("ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'worker' CHECK(agent_type IN ('worker','ceo'))");
  }
}

function migrateAddDirectiveId(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "directive_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN directive_id TEXT REFERENCES directives(id) ON DELETE SET NULL");
  }
}

function migrateAddTaskNumbering(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "task_number")) {
    db.exec("ALTER TABLE tasks ADD COLUMN task_number TEXT");
  }
  if (!cols.some((c) => c.name === "depends_on")) {
    db.exec("ALTER TABLE tasks ADD COLUMN depends_on TEXT");
  }
}

function migrateAddInteractivePrompt(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "interactive_prompt_data")) {
    db.exec("ALTER TABLE tasks ADD COLUMN interactive_prompt_data TEXT");
  }
}

function migrateAddPrUrl(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "pr_url")) {
    db.exec("ALTER TABLE tasks ADD COLUMN pr_url TEXT");
  }
}

function migrateAddExternalTaskRef(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "external_source")) {
    db.exec("ALTER TABLE tasks ADD COLUMN external_source TEXT");
  }
  if (!cols.some((c) => c.name === "external_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN external_id TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_ref ON tasks(external_source, external_id)");
}

function migrateAddReviewArtifactFields(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "review_branch")) {
    db.exec("ALTER TABLE tasks ADD COLUMN review_branch TEXT");
  }
  if (!cols.some((c) => c.name === "review_commit_sha")) {
    db.exec("ALTER TABLE tasks ADD COLUMN review_commit_sha TEXT");
  }
  if (!cols.some((c) => c.name === "review_sync_status")) {
    db.exec("ALTER TABLE tasks ADD COLUMN review_sync_status TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!cols.some((c) => c.name === "review_sync_error")) {
    db.exec("ALTER TABLE tasks ADD COLUMN review_sync_error TEXT");
  }
}

function migrateAddQaTestingStatus(_db: DatabaseSync): void {
  // Migration already applied — CHECK constraint includes qa_testing.
  // No-op to avoid repeated table rebuild attempts.
}

function backfillTaskNumbers(db: DatabaseSync): void {
  const rows = db.prepare(
    "SELECT id FROM tasks WHERE task_number IS NULL ORDER BY created_at ASC"
  ).all() as Array<{ id: string }>;
  if (rows.length === 0) return;

  const maxRow = db.prepare(
    "SELECT MAX(CAST(SUBSTR(task_number, 2) AS INTEGER)) AS max_num FROM tasks WHERE task_number LIKE '#%'"
  ).get() as { max_num: number | null } | undefined;
  let seq = (maxRow?.max_num ?? 0) + 1;

  const update = db.prepare("UPDATE tasks SET task_number = ? WHERE id = ?");
  for (const row of rows) {
    update.run(`#${seq}`, row.id);
    seq++;
  }
}

function backfillCliModels(db: DatabaseSync): void {
  const update = db.prepare(
    "UPDATE agents SET cli_model = ? WHERE cli_provider = ? AND cli_model IS NULL"
  );
  for (const [provider, model] of Object.entries(DEFAULT_CLI_MODELS)) {
    update.run(model, provider);
  }
}

function seedDefaults(db: DatabaseSync): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    insert.run(key, String(value));
  }
}
