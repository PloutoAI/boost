/**
 * Lean JSONL → Plouto metadata sync.
 *
 * Scans local Claude Code session logs and pushes session + turn
 * *metadata* (never content) to Plouto's `/api/ingest/sessions`. Runs
 * inside the SessionStart hook when connected; best-effort, bounded,
 * never blocks startup.
 *
 * Design (see the sync-approach review):
 *   - Cursor = per-file byte offset (append-only JSONL → byte cursor is
 *     the proven pattern; mirrors `jsonl_ingest_state` and the Python
 *     adapter's `jsonl_offset`). Handles long-lived sessions for free:
 *     new turns = new bytes = uploaded.
 *   - Idempotency = the server upserts on session_id/request_id, so
 *     overlap and retries are safe. The cursor is an optimization, not a
 *     correctness requirement — we only advance it on a successful POST.
 *   - No separate backfill path: each run uploads a bounded batch
 *     (MAX_TURNS_PER_RUN), so history self-completes over a few sessions
 *     without ever risking the hook's timeout.
 *   - Metadata-only by construction: we only read numeric/id/enum fields
 *     via the existing pure extractors. Content is never reached for.
 *   - 90-day window (matches the adapter); older files are skipped.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Database as BunDatabase } from "bun:sqlite";

import { discoverJsonl } from "../data/jsonl-discover.ts";
import { parseJsonl } from "../data/jsonl-parser.ts";
import {
  asRawLine,
  extractApiRequest,
  numOr,
  strOrNull,
  type RawLine,
} from "../data/jsonl-payload.ts";
import type { IngestBatch, IngestSessionWire, IngestTurnWire, PloutoClient } from "./client.ts";

const BACKFILL_WINDOW_DAYS = 90;
const MAX_TURNS_PER_BATCH = 300; // bound POST body size
const MAX_TURNS_PER_RUN = 4000; // bound per-session work; rest catches up next run
const FIRST_OBJECT_MAX_BYTES = 256 * 1024;

export interface IngestSyncResult {
  filesScanned: number;
  filesUploaded: number;
  turnsUploaded: number;
  hitRunCap: boolean;
}

export async function runIngestSync(
  db: BunDatabase,
  client: PloutoClient,
  opts: { warn?: (m: string) => void } = {},
): Promise<IngestSyncResult> {
  const warn = opts.warn ?? (() => {});
  ensureUploadStateTable(db);

  const identity = gitIdentity();
  // Discovery returns mtime ASC; reverse so the *active* session (just
  // touched) syncs first and history backfills behind it.
  const files = discoverJsonl({ warn }).reverse();
  const cutoffMs = Date.now() - BACKFILL_WINDOW_DAYS * 86_400_000;

  const result: IngestSyncResult = {
    filesScanned: 0,
    filesUploaded: 0,
    turnsUploaded: 0,
    hitRunCap: false,
  };

  for (const file of files) {
    if (result.turnsUploaded >= MAX_TURNS_PER_RUN) {
      result.hitRunCap = true;
      break;
    }
    if (file.mtimeMs < cutoffMs) continue; // outside the 90-day window
    result.filesScanned += 1;

    const uploadedOffset = getUploadOffset(db, file.path);
    if (file.size <= uploadedOffset) continue; // nothing new

    const turns = collectTurns(file.path, uploadedOffset);
    if (turns.list.length === 0) {
      // Only non-turn lines (tool/system) were appended — advance past
      // them so we don't re-scan, but nothing to upload.
      setUploadOffset(db, file.path, turns.endOffset);
      continue;
    }

    const sessions = buildSessions(file.path, turns.list, turns.firstObject);
    const ok = await uploadFile(client, sessions, turns.list, identity);
    if (!ok) {
      warn(`plouto ingest: upload failed for ${file.path}; will retry next session`);
      continue; // leave cursor unadvanced → retry next run (server dedups)
    }
    setUploadOffset(db, file.path, turns.endOffset);
    result.filesUploaded += 1;
    result.turnsUploaded += turns.list.length;
  }

  return result;
}

// ── upload ──────────────────────────────────────────────────────────

async function uploadFile(
  client: PloutoClient,
  sessions: IngestSessionWire[],
  turns: IngestTurnWire[],
  identity: IngestBatch["agent_identity"],
): Promise<boolean> {
  // One file is normally one session; chunk its turns to bound body size.
  // The session list rides every chunk (server upserts it idempotently).
  for (let i = 0; i < turns.length; i += MAX_TURNS_PER_BATCH) {
    const chunk = turns.slice(i, i + MAX_TURNS_PER_BATCH);
    const ok = await client.ingestSessions({
      provider_kind: "claude_code",
      sessions,
      turns: chunk,
      agent_identity: identity,
    });
    if (!ok) return false;
  }
  return true;
}

// ── parsing / mapping ───────────────────────────────────────────────

interface CollectedTurns {
  list: IngestTurnWire[];
  endOffset: number;
  firstObject: RawLine | null;
}

function collectTurns(filePath: string, fromOffset: number): CollectedTurns {
  const parsed = parseJsonl(filePath, fromOffset);
  const list: IngestTurnWire[] = [];
  for (const m of parsed.messages) {
    const raw = asRawLine(m.raw);
    if (!raw) continue;
    const turn = lineToTurn(raw);
    if (turn) list.push(turn);
  }
  return {
    list,
    endOffset: parsed.endOffset,
    firstObject: readFirstObject(filePath),
  };
}

/** Map a JSONL line to a lean turn payload, or null if it isn't a
 *  user/assistant turn (tool/system lines are skipped in v1). */
function lineToTurn(raw: RawLine): IngestTurnWire | null {
  const uuid = strOrNull(raw.uuid);
  const sessionId = strOrNull(raw.sessionId);
  const timestamp = strOrNull(raw.timestamp);
  if (!uuid || !sessionId || !timestamp) return null;

  const role = raw.message?.role;

  if (role === "assistant") {
    const extracted = extractApiRequest(raw);
    if (!extracted) return null;
    const p = extracted.payload;
    return {
      uuid,
      session_id: sessionId,
      parent_uuid: p.parent_uuid,
      is_sidechain: p.is_sidechain,
      turn_type: "assistant",
      timestamp,
      model_id: p.model,
      stop_reason: p.stop_reason,
      input_tokens: p.input_tokens,
      output_tokens: p.output_tokens,
      cache_read_tokens: p.cache_read_tokens,
      cache_creation_5m_tokens: p.cache_creation_5m_tokens,
      cache_creation_1h_tokens: p.cache_creation_1h_tokens,
      request_id: p.request_id,
      iterations: p.iterations,
      speed: p.speed,
      service_tier: p.service_tier,
    };
  }

  if (role === "user") {
    return {
      uuid,
      session_id: sessionId,
      turn_type: "user",
      timestamp,
      is_sidechain: raw.isSidechain === true,
    };
  }

  return null;
}

/** Build a session row per distinct session_id seen in the turns. File
 *  metadata (cwd, started_at, branch) comes from the file's first line,
 *  so it stays stable across incremental uploads. */
function buildSessions(
  filePath: string,
  turns: IngestTurnWire[],
  firstObject: RawLine | null,
): IngestSessionWire[] {
  const projectPathEncoded = path.basename(path.dirname(filePath));
  const cwd =
    strOrNull(firstObject?.cwd) ?? decodeProjectPath(projectPathEncoded) ?? "(unknown)";
  const gitBranch = strOrNull(firstObject?.gitBranch);
  const cliVersion = firstObject ? strOrNull((firstObject as Record<string, unknown>)["version"]) : null;
  const startedAt =
    strOrNull(firstObject?.timestamp) ?? turns[0]?.timestamp ?? new Date().toISOString();
  // ended_at advances with the newest turn we're shipping (server upserts).
  let endedAt = startedAt;
  for (const t of turns) if (t.timestamp > endedAt) endedAt = t.timestamp;

  const ids = new Set(turns.map((t) => t.session_id));
  return [...ids].map((id) => ({
    id,
    cwd,
    project_path_encoded: projectPathEncoded,
    git_branch: gitBranch,
    cli_version: cliVersion,
    started_at: startedAt,
    ended_at: endedAt,
    is_subagent: 0,
    jsonl_path: filePath,
  }));
}

/** "-Users-me-proj" → "/Users/me/proj" (best-effort; lossy on names
 *  that legitimately contain dashes, hence only a cwd fallback). */
function decodeProjectPath(encoded: string): string | null {
  if (!encoded || encoded === ".") return null;
  return encoded.replace(/-/g, "/");
}

function readFirstObject(filePath: string): RawLine | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(FIRST_OBJECT_MAX_BYTES, size));
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    const slice = buf.subarray(0, got);
    const nl = slice.indexOf(0x0a);
    const text = (nl === -1 ? slice : slice.subarray(0, nl)).toString("utf8").trim();
    if (!text) return null;
    return asRawLine(JSON.parse(text));
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// ── git identity ────────────────────────────────────────────────────

/** Read git user.email/name so the server attributes sessions to the
 *  right engineer. Argv-style spawn — never a shell. Best-effort. */
function gitIdentity(): IngestBatch["agent_identity"] {
  const email = gitConfig("user.email");
  if (!email) return undefined;
  return { email, display_name: gitConfig("user.name") };
}

function gitConfig(key: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "config", "--global", key], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout.toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ── cursor store ────────────────────────────────────────────────────
// Plugin-managed auxiliary state; created idempotently here rather than
// via the core migration system (it's not part of the detector schema).

function ensureUploadStateTable(db: BunDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ingest_upload_state (
       jsonl_path       TEXT PRIMARY KEY,
       uploaded_offset  INTEGER NOT NULL,
       updated_at       TEXT NOT NULL
     )`,
  );
}

function getUploadOffset(db: BunDatabase, jsonlPath: string): number {
  const row = db
    .query<{ uploaded_offset: number }, [string]>(
      "SELECT uploaded_offset FROM ingest_upload_state WHERE jsonl_path = ?",
    )
    .get(jsonlPath);
  return row?.uploaded_offset ?? 0;
}

function setUploadOffset(db: BunDatabase, jsonlPath: string, offset: number): void {
  db.prepare(
    `INSERT INTO ingest_upload_state (jsonl_path, uploaded_offset, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(jsonl_path) DO UPDATE SET
       uploaded_offset = excluded.uploaded_offset,
       updated_at = excluded.updated_at`,
  ).run(jsonlPath, offset, new Date().toISOString());
}
