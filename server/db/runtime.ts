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
  migrateAddWorkflowStages(db);
  migrateAddLogStageAgent(db);
  migrateAddLastHeartbeat(db);
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

function migrateAddWorkflowStages(db: DatabaseSync): void {
  // Add test_generation, human_review, pre_deploy to the status CHECK constraint.
  // SQLite doesn't support ALTER CHECK, so we rebuild the table.
  const checkInfo = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
  ).get() as { sql: string } | undefined;
  if (!checkInfo) return;

  // Skip if already migrated
  if (checkInfo.sql.includes("test_generation")) return;

  db.exec("BEGIN TRANSACTION");
  try {
    db.exec("ALTER TABLE tasks RENAME TO tasks_old");
    db.exec(SCHEMA_SQL.split("CREATE TABLE IF NOT EXISTS tasks")[0]); // tables before tasks are already created
    // Recreate tasks table with new CHECK constraint (from SCHEMA_SQL)
    const tasksSchema = SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS tasks \([\s\S]*?\);/);
    if (tasksSchema) {
      db.exec(tasksSchema[0]);
    }
    // Copy data
    const cols = (db.prepare("PRAGMA table_info(tasks_old)").all() as Array<{ name: string }>)
      .map(c => c.name);
    const newCols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>)
      .map(c => c.name);
    const commonCols = cols.filter(c => newCols.includes(c));
    const colList = commonCols.join(", ");
    db.exec(`INSERT INTO tasks (${colList}) SELECT ${colList} FROM tasks_old`);
    db.exec("DROP TABLE tasks_old");
    // Recreate indexes
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_ref ON tasks(external_source, external_id)");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function migrateAddLastHeartbeat(db: DatabaseSync): void {
  // Add tasks.last_heartbeat_at — a liveness signal that is updated on a
  // fixed interval while a process is actively running against a task.
  // Orphan recovery treats a task as stuck when its heartbeat is stale,
  // which is more reliable than relying on updated_at (which does not
  // advance for tasks that only produce log output).
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "last_heartbeat_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN last_heartbeat_at INTEGER");
  }
}

function migrateAddLogStageAgent(db: DatabaseSync): void {
  // Add stage/agent_id columns to task_logs so every log entry records
  // which workflow stage (tasks.status) and which agent was active at insert time.
  const cols = db.prepare("PRAGMA table_info(task_logs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "stage")) {
    db.exec("ALTER TABLE task_logs ADD COLUMN stage TEXT");
  }
  if (!cols.some((c) => c.name === "agent_id")) {
    db.exec("ALTER TABLE task_logs ADD COLUMN agent_id TEXT");
  }

  // AFTER INSERT trigger: auto-populate stage/agent_id from tasks when caller did not set them.
  // This avoids having to touch 29 task_logs INSERT sites across the codebase.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS task_logs_fill_metadata
    AFTER INSERT ON task_logs
    FOR EACH ROW
    WHEN NEW.stage IS NULL OR NEW.agent_id IS NULL
    BEGIN
      UPDATE task_logs
      SET stage = COALESCE(NEW.stage, (SELECT status FROM tasks WHERE id = NEW.task_id)),
          agent_id = COALESCE(NEW.agent_id, (SELECT assigned_agent_id FROM tasks WHERE id = NEW.task_id))
      WHERE id = NEW.id;
    END;
  `);

  // AFTER UPDATE trigger on tasks: emit a synthetic system log on every status change,
  // so the terminal/timeline always shows a clear "stage transition" marker
  // without having to modify the 21 status-update call sites.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_log_stage_transition
    AFTER UPDATE OF status ON tasks
    FOR EACH ROW
    WHEN NEW.status IS NOT OLD.status
    BEGIN
      INSERT INTO task_logs (task_id, kind, message, stage, agent_id)
      VALUES (
        NEW.id,
        'system',
        '__STAGE_TRANSITION__:' || COALESCE(OLD.status, 'null') || '→' || NEW.status,
        NEW.status,
        NEW.assigned_agent_id
      );
    END;
  `);

  // Backfill stage/agent_id for existing rows using current task state
  // (best-effort — historical accuracy is not required).
  db.exec(`
    UPDATE task_logs
    SET stage = COALESCE(stage, (SELECT status FROM tasks WHERE tasks.id = task_logs.task_id)),
        agent_id = COALESCE(agent_id, (SELECT assigned_agent_id FROM tasks WHERE tasks.id = task_logs.task_id))
    WHERE stage IS NULL OR agent_id IS NULL;
  `);
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
