/**
 * Incremental JSONL ingestion. Discovers files, resumes from each file's
 * last byte offset (stored in `jsonl_ingest_state`), parses, normalizes, and
 * persists. Idempotent: running twice in a row with no changes is a no-op.
 */
import type { Database as BunDatabase } from "bun:sqlite";
import { DAY_MS } from "../time.ts";
import { discoverJsonl } from "./jsonl-discover.ts";
import { parseJsonl } from "./jsonl-parser.ts";
import { normalizeAndInsert, type NormalizeContext } from "./jsonl-normalizer.ts";

export type IngestSummary = {
  filesScanned: number;
  filesUpdated: number;
  messagesIngested: number;
  warnings: string[];
};

export type IngestOptions = {
  warn?: (msg: string) => void;
};

/** Run one pass over `~/.claude/projects/`. */
export function ingestAll(ctx: NormalizeContext, opts: IngestOptions = {}): IngestSummary {
  const warnings: string[] = [];
  const warn = opts.warn ?? ((m: string) => warnings.push(m));
  const files = discoverJsonl({ warn });
  let messagesIngested = 0;
  let filesUpdated = 0;

  for (const file of files) {
    const state = readIngestState(ctx.db, file.path);
    let resumeFrom = 0;
    if (state) {
      // File truncated/replaced — restart from 0.
      if (file.size < state.last_byte_offset) {
        resumeFrom = 0;
      } else if (file.mtimeMs <= state.last_mtime_ms && file.size <= state.last_byte_offset) {
        // Nothing new; skip.
        continue;
      } else {
        resumeFrom = state.last_byte_offset;
      }
    }

    let parsed: ReturnType<typeof parseJsonl>;
    try {
      parsed = parseJsonl(file.path, resumeFrom);
    } catch (err) {
      warn(`failed to parse ${file.path}: ${(err as Error).message}`);
      continue;
    }
    for (const w of parsed.warnings) warn(w);

    const tx = ctx.db.transaction(() => {
      for (const m of parsed.messages) {
        const r = normalizeAndInsert(ctx, m.raw);
        messagesIngested += r.inserted;
      }
      writeIngestState(ctx.db, {
        file_path: file.path,
        last_byte_offset: parsed.endOffset,
        last_mtime_ms: file.mtimeMs,
        last_seen_iso: new Date().toISOString(),
      });
    });
    tx();
    filesUpdated += 1;
  }

  return {
    filesScanned: files.length,
    filesUpdated,
    messagesIngested,
    warnings,
  };
}

type IngestStateRow = {
  file_path: string;
  last_byte_offset: number;
  last_mtime_ms: number;
  last_seen_iso: string;
};

function readIngestState(db: BunDatabase, filePath: string): IngestStateRow | null {
  const row = db
    .query("SELECT file_path, last_byte_offset, last_mtime_ms, last_seen_iso FROM jsonl_ingest_state WHERE file_path = ?")
    .get(filePath) as IngestStateRow | null;
  return row ?? null;
}

function writeIngestState(db: BunDatabase, row: IngestStateRow): void {
  db.prepare(
    `INSERT INTO jsonl_ingest_state (file_path, last_byte_offset, last_mtime_ms, last_seen_iso)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       last_byte_offset = excluded.last_byte_offset,
       last_mtime_ms = excluded.last_mtime_ms,
       last_seen_iso = excluded.last_seen_iso`,
  ).run(row.file_path, row.last_byte_offset, row.last_mtime_ms, row.last_seen_iso);
}

/** Helper used in cold-start handling — number of distinct days of data. */
export function daysOfDataAvailable(db: BunDatabase): number {
  const row = db
    .query<
      { min_ts: string | null; max_ts: string | null },
      []
    >("SELECT MIN(timestamp_iso) AS min_ts, MAX(timestamp_iso) AS max_ts FROM events")
    .get();
  if (!row || !row.min_ts || !row.max_ts) return 0;
  const min = Date.parse(row.min_ts);
  const max = Date.parse(row.max_ts);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  const ms = max - min;
  return Math.max(0, Math.floor(ms / DAY_MS));
}

