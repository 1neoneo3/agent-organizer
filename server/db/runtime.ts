import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.js";
import { DB_PATH, SETTINGS_DEFAULTS, DEFAULT_CLI_MODELS } from "../config/runtime.js";
import { detectRepositoryUrl } from "../workflow/git-utils.js";
import {
  VALID_TASK_NUMBER_SQL,
  buildRecoveredTaskTitle,
  isUuidLikeTitle,
} from "../domain/task-number.js";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error("Database not initialized. Call initializeDb() first.");
  return db;
}

export function initializeDb(dbPath?: string): DatabaseSync {
  const effectivePath = dbPath ?? DB_PATH;
  mkdirSync(dirname(effectivePath), { recursive: true });
  db = new DatabaseSync(effectivePath);

  // Core safety settings
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  // Write-path tuning: with WAL, synchronous = NORMAL is corruption-safe
  // per https://www.sqlite.org/pragma.html#pragma_synchronous and cuts the
  // fsync cost of each COMMIT dramatically. This is the single biggest
  // write-throughput win for an agent-organizer-sized workload.
  db.exec("PRAGMA synchronous = NORMAL");

  // Read-path tuning:
  //   cache_size = -32000      → 32MB page cache (negative = KB). The
  //                              full working set of tasks / task_logs /
  //                              agents fits in this at typical scale.
  //   temp_store = MEMORY      → keep ORDER BY / GROUP BY temp tables in
  //                              RAM instead of spilling to disk.
  //   mmap_size  = 64 * 1024^2 → memory-map 64MB of the DB file so read
  //                              paths can skip per-page read() syscalls.
  db.exec("PRAGMA cache_size = -32000");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA mmap_size = 67108864");

  db.exec(SCHEMA_SQL);
  migrateAddTaskLogHotQueryIndexes(db);
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
  migrateAddRepositoryUrl(db);
  migrateAddRefinementStage(db);
  migrateAddMultiUrls(db);
  migrateAddAutoRespawnCount(db);
  migrateAddRefinementCompletedAt(db);
  migrateAddRefinementRevisionTracking(db);
  migrateAddPlannedFiles(db);
  migrateAddMergedPrUrls(db);
  migrateAddSettingsOverrides(db);
  migrateAddControllerFields(db);
  migrateStageAgentSelectionSettings(db);
  const repairedTaskNumberMap = repairBrokenTaskNumbers(db);
  backfillTaskNumbers(db);
  repairBrokenDependsOnReferences(db, repairedTaskNumberMap);
  repairMachineGeneratedTaskTitles(db);
  seedDefaults(db);
  backfillCliModels(db);
  return db;
}

function migrateAddTaskLogHotQueryIndexes(db: DatabaseSync): void {
  // Promote the hot-query helper index for `WHERE task_id = ? ORDER BY id`
  // to a stable schema index. Older databases may still carry the temporary
  // `idx_tmp_task_logs_task_only(task_id)` helper; replace it so reads keep
  // the benefit without paying duplicate write amplification forever.
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id, id DESC)");
  db.exec("DROP INDEX IF EXISTS idx_tmp_task_logs_task_only");
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

function migrateAddControllerFields(db: DatabaseSync): void {
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!taskCols.some((c) => c.name === "controller_stage")) {
    db.exec("ALTER TABLE tasks ADD COLUMN controller_stage TEXT CHECK(controller_stage IN ('implement','verify','integrate'))");
  }
  if (!taskCols.some((c) => c.name === "write_scope")) {
    db.exec("ALTER TABLE tasks ADD COLUMN write_scope TEXT");
  }

  const directiveCols = db.prepare("PRAGMA table_info(directives)").all() as Array<{ name: string }>;
  if (!directiveCols.some((c) => c.name === "controller_mode")) {
    db.exec("ALTER TABLE directives ADD COLUMN controller_mode INTEGER NOT NULL DEFAULT 0");
  }
  if (!directiveCols.some((c) => c.name === "controller_stage")) {
    db.exec("ALTER TABLE directives ADD COLUMN controller_stage TEXT CHECK(controller_stage IN ('implement','verify','integrate','blocked','completed'))");
  }
  if (!directiveCols.some((c) => c.name === "aggregated_result")) {
    db.exec("ALTER TABLE directives ADD COLUMN aggregated_result TEXT");
  }
  if (!directiveCols.some((c) => c.name === "completed_at")) {
    db.exec("ALTER TABLE directives ADD COLUMN completed_at INTEGER");
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_directives_controller ON directives(controller_mode, status, controller_stage)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_directive_controller_stage ON tasks(directive_id, controller_stage, status)");
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

/**
 * Rebuild the tasks table from SCHEMA_SQL to pick up CHECK constraint
 * changes. Also rebuilds child tables (task_logs, subtasks, messages)
 * whose FK references follow the renamed table in SQLite, and drops
 * triggers so they can be cleanly recreated by migrateAddLogStageAgent.
 */
function rebuildTasksTable(db: DatabaseSync): void {
  // Drop triggers BEFORE renaming so they don't fire during the rebuild
  db.exec("DROP TRIGGER IF EXISTS task_logs_fill_metadata");
  db.exec("DROP TRIGGER IF EXISTS tasks_log_stage_transition");

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN TRANSACTION");
  try {
    // Rebuild tasks
    db.exec("ALTER TABLE tasks RENAME TO tasks_old");
    const tasksSchema = SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS tasks \([\s\S]*?\);/);
    if (tasksSchema) db.exec(tasksSchema[0]);
    const oldCols = (db.prepare("PRAGMA table_info(tasks_old)").all() as Array<{ name: string }>).map(c => c.name);
    const newCols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(c => c.name);
    const colList = oldCols.filter(c => newCols.includes(c)).join(", ");
    db.exec(`INSERT INTO tasks (${colList}) SELECT ${colList} FROM tasks_old`);
    db.exec("DROP TABLE tasks_old");

    // Rebuild child tables whose FK silently followed the rename
    rebuildChildTable(db, "task_logs", SCHEMA_SQL);
    rebuildChildTable(db, "subtasks", SCHEMA_SQL);
    rebuildChildTable(db, "messages", SCHEMA_SQL);

    // Recreate indexes from SCHEMA_SQL
    const indexMatches = SCHEMA_SQL.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \S+ ON (?:tasks|task_logs|subtasks|messages)\b[^;]+;/g);
    for (const m of indexMatches) db.exec(m[0]);

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

function rebuildChildTable(db: DatabaseSync, tableName: string, schemaSql: string): void {
  const checkInfo = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName) as { sql: string } | undefined;
  if (!checkInfo || !checkInfo.sql.includes("tasks_old")) return;

  const bakName = `${tableName}_bak`;
  db.exec(`ALTER TABLE ${tableName} RENAME TO ${bakName}`);
  const schemaMatch = schemaSql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\);`));
  if (schemaMatch) db.exec(schemaMatch[0]);
  const oldCols = (db.prepare(`PRAGMA table_info(${bakName})`).all() as Array<{ name: string }>).map(c => c.name);
  const newCols = (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map(c => c.name);
  const colList = oldCols.filter(c => newCols.includes(c)).join(", ");
  db.exec(`INSERT INTO ${tableName} (${colList}) SELECT ${colList} FROM ${bakName}`);
  db.exec(`DROP TABLE ${bakName}`);
}

function migrateAddWorkflowStages(db: DatabaseSync): void {
  // Add workflow stages to the status CHECK constraint.
  // SQLite doesn't support ALTER CHECK, so we rebuild the table.
  const checkInfo = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
  ).get() as { sql: string } | undefined;
  if (!checkInfo) return;

  const needsWorkflowStages = !checkInfo.sql.includes("test_generation");
  const hasLegacySelfReview = checkInfo.sql.includes("self_review");
  if (!needsWorkflowStages && !hasLegacySelfReview) return;

  if (hasLegacySelfReview) {
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE status = 'self_review'").run();
  }

  rebuildTasksTable(db);
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

function migrateAddRepositoryUrl(db: DatabaseSync): void {
  // Add tasks.repository_url — a canonical HTTPS form of the project's
  // git origin URL. The column is auto-populated at task creation time
  // (see routes/tasks.ts) and backfilled here for any existing rows so
  // the UI always has a clickable repository link available.
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "repository_url")) return;

  db.exec("ALTER TABLE tasks ADD COLUMN repository_url TEXT");

  // Backfill: walk every task with a project_path and try to detect its
  // origin remote. A single `spawnSync` per task is cheap (no shell) and
  // the migration only runs once per DB.
  const rows = db.prepare(
    "SELECT id, project_path FROM tasks WHERE project_path IS NOT NULL AND project_path <> ''",
  ).all() as Array<{ id: string; project_path: string }>;
  if (rows.length === 0) return;

  const update = db.prepare("UPDATE tasks SET repository_url = ? WHERE id = ?");
  for (const row of rows) {
    const url = detectRepositoryUrl(row.project_path);
    if (url) {
      update.run(url, row.id);
    }
  }
}

function migrateAddMultiUrls(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "repository_urls")) {
    db.exec("ALTER TABLE tasks ADD COLUMN repository_urls TEXT");
    // Backfill from existing single repository_url
    const rows = db.prepare(
      "SELECT id, repository_url FROM tasks WHERE repository_url IS NOT NULL AND repository_url <> ''",
    ).all() as Array<{ id: string; repository_url: string }>;
    const upd = db.prepare("UPDATE tasks SET repository_urls = ? WHERE id = ?");
    for (const r of rows) {
      upd.run(JSON.stringify([r.repository_url]), r.id);
    }
  }
  if (!cols.some((c) => c.name === "pr_urls")) {
    db.exec("ALTER TABLE tasks ADD COLUMN pr_urls TEXT");
    const rows = db.prepare(
      "SELECT id, pr_url FROM tasks WHERE pr_url IS NOT NULL AND pr_url <> ''",
    ).all() as Array<{ id: string; pr_url: string }>;
    const upd = db.prepare("UPDATE tasks SET pr_urls = ? WHERE id = ?");
    for (const r of rows) {
      upd.run(JSON.stringify([r.pr_url]), r.id);
    }
  }
}

function migrateAddAutoRespawnCount(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "auto_respawn_count")) {
    db.exec("ALTER TABLE tasks ADD COLUMN auto_respawn_count INTEGER NOT NULL DEFAULT 0");
  }
}

function migrateAddPlannedFiles(db: DatabaseSync): void {
  // Static file-conflict detection for the #99 follow-up. Each task
  // stores a JSON array of repo-relative paths it intends to modify,
  // extracted from the "## Files to Modify" section of its
  // refinement_plan. The file-conflict gate in
  // domain/task-dependencies compares overlapping paths against any
  // other task still in an editing stage (in_progress, refinement,
  // etc.) and blocks advancement the same way declared depends_on does.
  //
  // No backfill is possible for existing rows: their refinement_plan
  // (when present at all) was written before the agent was aware this
  // field would be consumed, and re-extraction may or may not find a
  // matching heading. Leaving NULL is correct — the check treats that
  // as "no static overlap data" and falls back to the declarative
  // depends_on gate alone.
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "planned_files")) return;
  db.exec("ALTER TABLE tasks ADD COLUMN planned_files TEXT");
}

function migrateAddSettingsOverrides(db: DatabaseSync): void {
  // Per-task settings overrides JSON blob. Readers assume the column
  // exists (domain/task-settings.ts), but the schema & migration list
  // never registered it — existing installations got the column via an
  // unrecorded manual ALTER, so fresh installs / ephemeral in-memory DBs
  // used in tests would crash with "no such column". Adding the
  // migration closes that gap without affecting production databases
  // that already have the column.
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "settings_overrides")) return;
  db.exec("ALTER TABLE tasks ADD COLUMN settings_overrides TEXT");
}

function migrateStageAgentSelectionSettings(db: DatabaseSync): void {
  const legacyToNext = [
    {
      legacyKey: "refinement_agent_id",
      roleKey: "refinement_agent_role",
      modelKey: "refinement_agent_model",
    },
    {
      legacyKey: "review_agent_id",
      roleKey: "review_agent_role",
      modelKey: "review_agent_model",
    },
    {
      legacyKey: "qa_agent_id",
      roleKey: "qa_agent_role",
      modelKey: "qa_agent_model",
    },
    {
      legacyKey: "test_generation_agent_id",
      roleKey: "test_generation_agent_role",
      modelKey: "test_generation_agent_model",
    },
  ] as const;

  for (const mapping of legacyToNext) {
    const legacyRow = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(mapping.legacyKey) as { value: string } | undefined;
    const hasRole = Boolean(
      db.prepare("SELECT 1 FROM settings WHERE key = ? LIMIT 1").get(mapping.roleKey),
    );
    const hasModel = Boolean(
      db.prepare("SELECT 1 FROM settings WHERE key = ? LIMIT 1").get(mapping.modelKey),
    );

    if (legacyRow?.value?.trim() && !hasRole && !hasModel) {
      const agent = db
        .prepare("SELECT role, cli_model FROM agents WHERE id = ? LIMIT 1")
        .get(legacyRow.value.trim()) as { role: string | null; cli_model: string | null } | undefined;

      if (agent) {
        const now = Date.now();
        if (agent.role) {
          db.prepare(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          ).run(mapping.roleKey, agent.role, now);
        }
        if (agent.cli_model) {
          db.prepare(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          ).run(mapping.modelKey, agent.cli_model, now);
        }
      }
    }

    db.prepare("DELETE FROM settings WHERE key = ?").run(mapping.legacyKey);
  }

  db.prepare("DELETE FROM settings WHERE key = ?").run("ci_check_agent_id");
}

function migrateAddMergedPrUrls(db: DatabaseSync): void {
  // JSON array of PR URLs that have been confirmed merged via GitHub
  // webhook. Used to gate `pr_urls`-multi-PR tasks: a task flips to
  // `done` only when every URL in `pr_urls` also appears in
  // `merged_pr_urls`. Single-PR tasks never touch this column.
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "merged_pr_urls")) return;
  db.exec("ALTER TABLE tasks ADD COLUMN merged_pr_urls TEXT");
}

function migrateAddRefinementCompletedAt(db: DatabaseSync): void {
  // PR 3 of issue #99: track when a refinement run actually finished
  // producing a plan, so re-spawns after a crash can tell "refinement
  // already completed, move on" apart from "refinement never ran".
  //
  // Without this column we only have `refinement_plan IS NOT NULL`,
  // which lies in both directions: (a) an `"empty"` branch from PR 2
  // may legitimately leave the plan untouched even though refinement
  // ran, and (b) a backfill slice from an old fallback path may have
  // written a partial string that has no marker block. The timestamp
  // column lets the re-spawn guard distinguish "we finalized a plan"
  // from "the column just happens to be non-null".
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "refinement_completed_at")) return;

  db.exec("ALTER TABLE tasks ADD COLUMN refinement_completed_at INTEGER");

  // Backfill: existing rows with a populated `refinement_plan` must not
  // be treated as "never refined" on first boot after the upgrade — or
  // the re-spawn logic in spawnAgent would queue a fresh refinement run
  // for every in-flight task.
  //
  // Source ordering: prefer `started_at` over `completed_at` because
  // completed_at can carry garbage (future dates, 0, etc.) from legacy
  // writes — refinement by definition happened *after* the task started,
  // so started_at is a safer monotonic proxy. Fall back to updated_at /
  // created_at only when started_at is null (inbox-born rows that
  // somehow have a plan).
  db.exec(`
    UPDATE tasks
    SET refinement_completed_at = COALESCE(started_at, updated_at, created_at)
    WHERE refinement_completed_at IS NULL
      AND refinement_plan IS NOT NULL
      AND refinement_plan <> ''
  `);
}

function migrateAddRefinementRevisionTracking(db: DatabaseSync): void {
  // Track the latest plan revise request separately from the canonical
  // refinement completion timestamp so the UI can tell:
  //   1. a revise was requested and is still pending
  //   2. the revised plan has already been produced
  // without opening the task detail.
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "refinement_revision_requested_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN refinement_revision_requested_at INTEGER");
  }
  if (!cols.some((c) => c.name === "refinement_revision_completed_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN refinement_revision_completed_at INTEGER");
  }
}

function migrateAddRefinementStage(db: DatabaseSync): void {
  // Add refinement_plan column
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "refinement_plan")) {
    db.exec("ALTER TABLE tasks ADD COLUMN refinement_plan TEXT");
  }

  // Add 'refinement' to the status CHECK constraint (rebuild table if needed)
  const checkInfo = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
  ).get() as { sql: string } | undefined;
  if (!checkInfo) return;
  if (checkInfo.sql.includes("'refinement'")) return;

  rebuildTasksTable(db);
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

/**
 * Detect and repair task_number values that are UUID hex fragments
 * (e.g. `#40b0c5`, `#082098`) rather than sequential decimals. Such
 * values poison `nextTaskNumber()` by inflating the MAX and causing
 * all subsequent task numbers to jump. The repair re-assigns these
 * rows with the next valid sequential number.
 *
 * Detection: any `#`-prefixed task_number where the numeric part does
 * not survive a round-trip through INTEGER (leading zeros are stripped,
 * hex letters cause partial parsing).
 */
function repairBrokenTaskNumbers(db: DatabaseSync): Map<string, string> {
  const broken = db
    .prepare(
      `SELECT id, task_number FROM tasks
       WHERE task_number LIKE '#%'
         AND LENGTH(task_number) > 1
         AND CAST(CAST(SUBSTR(task_number, 2) AS INTEGER) AS TEXT) != SUBSTR(task_number, 2)
       ORDER BY created_at ASC`,
    ).all() as Array<{ id: string; task_number: string }>;
  if (broken.length === 0) return new Map();

  const maxRow = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(task_number, 2) AS INTEGER)) AS max_num FROM tasks WHERE ${VALID_TASK_NUMBER_SQL}`,
    )
    .get() as { max_num: number | null } | undefined;
  let seq = (maxRow?.max_num ?? 0) + 1;
  const repaired = new Map<string, string>();

  const update = db.prepare(
    "UPDATE tasks SET task_number = ? WHERE id = ?",
  );
  for (const row of broken) {
    const newTaskNumber = `#${seq}`;
    update.run(newTaskNumber, row.id);
    repaired.set(row.task_number, newTaskNumber);
    seq++;
  }
  return repaired;
}

function backfillTaskNumbers(db: DatabaseSync): void {
  const rows = db.prepare(
    "SELECT id FROM tasks WHERE task_number IS NULL ORDER BY created_at ASC"
  ).all() as Array<{ id: string }>;
  if (rows.length === 0) return;

  const maxRow = db.prepare(
    `SELECT MAX(CAST(SUBSTR(task_number, 2) AS INTEGER)) AS max_num FROM tasks WHERE ${VALID_TASK_NUMBER_SQL}`
  ).get() as { max_num: number | null } | undefined;
  let seq = (maxRow?.max_num ?? 0) + 1;

  const update = db.prepare("UPDATE tasks SET task_number = ? WHERE id = ?");
  for (const row of rows) {
    update.run(`#${seq}`, row.id);
    seq++;
  }
}

function repairBrokenDependsOnReferences(
  db: DatabaseSync,
  repairedTaskNumberMap: ReadonlyMap<string, string>,
): void {
  if (repairedTaskNumberMap.size === 0) return;

  const rows = db.prepare(
    "SELECT id, depends_on FROM tasks WHERE depends_on IS NOT NULL ORDER BY created_at ASC",
  ).all() as Array<{ id: string; depends_on: string | null }>;
  if (rows.length === 0) return;

  const update = db.prepare("UPDATE tasks SET depends_on = ?, updated_at = ? WHERE id = ?");
  const now = Date.now();

  for (const row of rows) {
    if (!row.depends_on) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.depends_on);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    let changed = false;
    const repairedDependsOn = parsed.map((entry) => {
      if (typeof entry !== "string") return entry;
      const repaired = repairedTaskNumberMap.get(entry);
      if (!repaired) return entry;
      changed = true;
      return repaired;
    });

    if (!changed) continue;
    update.run(JSON.stringify(repairedDependsOn), now, row.id);
  }
}

function repairMachineGeneratedTaskTitles(db: DatabaseSync): void {
  const rows = db.prepare(
    "SELECT id, title, task_number FROM tasks WHERE title LIKE 'Task %' ORDER BY created_at ASC",
  ).all() as Array<{ id: string; title: string; task_number: string | null }>;
  if (rows.length === 0) return;

  const update = db.prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) {
    if (!isUuidLikeTitle(row.title)) continue;
    update.run(buildRecoveredTaskTitle(row.task_number, row.id), Date.now(), row.id);
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
