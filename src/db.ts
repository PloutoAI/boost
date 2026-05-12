/**
 * SQLite-backed event log.
 *
 * - `Database.open()` initializes a fresh DB at `~/.boost/db.sqlite`, runs
 *   `PRAGMA integrity_check`, applies migrations, sets WAL.
 * - Migration ordering is filename-prefix numeric. Migrations are append-only.
 */
import { Database as BunDatabase } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { dbPath, versionFile } from "./paths.ts";

const CURRENT_SCHEMA_VERSION = 1;

/** Lightweight wrapper used everywhere — keeps the Bun-specific shape contained. */
export class LoopDatabase {
  constructor(public readonly db: BunDatabase) {}

  /** Open (or create) `~/.boost/db.sqlite`. Throws on integrity failure. */
  static open(filePath: string = dbPath()): LoopDatabase {
    const db = new BunDatabase(filePath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    const integrity = db.query("PRAGMA integrity_check;").get() as { integrity_check?: string } | null;
    if (integrity && integrity.integrity_check !== "ok") {
      throw new Error(
        `boost's database failed integrity check (${integrity.integrity_check ?? "?"}). ` +
          `Move ${filePath} aside and rerun boost to start fresh.`,
      );
    }

    LoopDatabase.runMigrations(db);
    return new LoopDatabase(db);
  }

  /** Apply migrations in `migrations/NNN-*.sql` whose number > current version. */
  static runMigrations(db: BunDatabase): void {
    const current = readSchemaVersion();
    const dir = migrationsDir();
    if (!fs.existsSync(dir)) {
      // Bundled fallback: use the inline schema when running from a built bundle.
      if (current < 1) {
        db.exec(INLINE_INITIAL_SCHEMA);
        writeSchemaVersion(1);
      }
      return;
    }
    const entries = fs
      .readdirSync(dir)
      .filter((f) => /^\d{3}-.*\.sql$/.test(f))
      .sort();
    let applied = current;
    for (const name of entries) {
      const num = Number.parseInt(name.slice(0, 3), 10);
      if (Number.isNaN(num) || num <= applied) continue;
      const sql = fs.readFileSync(path.join(dir, name), "utf8");
      db.exec(sql);
      applied = num;
      writeSchemaVersion(applied);
    }
    if (applied < CURRENT_SCHEMA_VERSION) {
      // Should never happen unless the migrations folder is missing 001.
      db.exec(INLINE_INITIAL_SCHEMA);
      writeSchemaVersion(CURRENT_SCHEMA_VERSION);
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Reads `~/.boost/version`, defaulting to 0 if absent or corrupt. */
function readSchemaVersion(): number {
  const file = versionFile();
  if (!fs.existsSync(file)) return 0;
  const raw = fs.readFileSync(file, "utf8").trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function writeSchemaVersion(v: number): void {
  fs.writeFileSync(versionFile(), `${v}\n`, { mode: 0o600 });
}

function migrationsDir(): string {
  // Resolve relative to this module so tests and the published bundle agree.
  // From src/db.ts → ../migrations.
  const here = new URL(".", import.meta.url).pathname;
  return path.resolve(here, "..", "migrations");
}

/** Used when `migrations/` is missing — keeps a published bundle self-contained. */
const INLINE_INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id        TEXT PRIMARY KEY,
  schema_version  INTEGER NOT NULL,
  timestamp_iso   TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  machine_id      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  session_id      TEXT,
  message_id      TEXT,
  event_type      TEXT NOT NULL,
  payload_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, timestamp_iso);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_msgid ON events(message_id) WHERE message_id IS NOT NULL;

-- Functional indexes on the hot json_extract paths used by detectors
-- introduced with payload schema v2. Partial-indexed on event_type so
-- the index stays small (only api_request rows have these fields).
-- SQLite's planner picks these up automatically when a query uses the
-- exact same json_extract expression.
CREATE INDEX IF NOT EXISTS idx_events_api_model
  ON events(json_extract(payload_json, '$.model'))
  WHERE event_type = 'api_request';
CREATE INDEX IF NOT EXISTS idx_events_api_sidechain
  ON events(json_extract(payload_json, '$.is_sidechain'))
  WHERE event_type = 'api_request';
CREATE INDEX IF NOT EXISTS idx_events_api_request_id
  ON events(json_extract(payload_json, '$.request_id'))
  WHERE event_type = 'api_request'
    AND json_extract(payload_json, '$.request_id') IS NOT NULL;

CREATE TABLE IF NOT EXISTS jsonl_ingest_state (
  file_path        TEXT PRIMARY KEY,
  last_byte_offset INTEGER NOT NULL,
  last_mtime_ms    INTEGER NOT NULL,
  last_seen_iso    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dismissed (
  strategy_id    TEXT PRIMARY KEY,
  dismissed_at   TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  operation_id            TEXT PRIMARY KEY,
  strategy_id             TEXT NOT NULL,
  strategy_version        INTEGER NOT NULL,
  applied_at_iso          TEXT NOT NULL,
  reverted_at_iso         TEXT,
  predicted_savings_pct   REAL,
  before_hash             TEXT NOT NULL,
  after_hash              TEXT NOT NULL,
  backup_ref_json         TEXT NOT NULL,
  source                  TEXT NOT NULL DEFAULT 'built-in'
);
CREATE INDEX IF NOT EXISTS idx_ops_strategy ON operations(strategy_id);

CREATE TABLE IF NOT EXISTS prune_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  last_pruned_at_iso   TEXT NOT NULL
);
`;
