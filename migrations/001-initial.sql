-- 001-initial.sql — initial schema for loop's event log
-- This migration is shipped; never edit. Add follow-ups as 002-*.sql etc.

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
