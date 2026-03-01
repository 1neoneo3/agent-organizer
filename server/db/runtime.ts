import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.js";
import { DB_PATH, REVIEW_SETTINGS_DEFAULTS, DEFAULT_CLI_MODELS } from "../config/runtime.js";

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
  for (const [key, value] of Object.entries(REVIEW_SETTINGS_DEFAULTS)) {
    insert.run(key, String(value));
  }
}
