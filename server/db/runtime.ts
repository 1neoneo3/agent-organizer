import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.js";
import { DB_PATH, REVIEW_SETTINGS_DEFAULTS } from "../config/runtime.js";

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
  seedDefaults(db);
  return db;
}

function seedDefaults(db: DatabaseSync): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  for (const [key, value] of Object.entries(REVIEW_SETTINGS_DEFAULTS)) {
    insert.run(key, String(value));
  }
}
