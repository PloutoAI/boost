/**
 * Convert raw Claude Code JSONL lines into rows in `events`.
 *
 * This module is a thin orchestrator: it dispatches each line to a
 * typed extractor in `jsonl-payload.ts`, then inserts one or more
 * `events` rows. All parsing rules, payload shapes, schema versioning,
 * and the privacy boundary live in `jsonl-payload.ts` — keep them there.
 *
 * Deduplication and idempotency:
 *
 * - Assistant turns dedup on `message.id` via the unique partial index
 *   on `events(message_id)`. Re-ingesting the same JSONL line is a no-op
 *   for the api_request row.
 * - User turns and synthesized child events (tool_use / tool_result /
 *   system subtypes) dedup on `event_id` (the line's `uuid`, sometimes
 *   suffixed with `#<role>:<index>` for in-message children).
 * - `INSERT OR IGNORE` is the enforcement; the unique indexes are the
 *   contract. Both are tested in tests/jsonl-normalizer.test.ts.
 *
 * Schema bump (v1 → v2 in this commit) widens api_request payloads and
 * adds three system event types (auto_compact, turn_duration,
 * api_error). Older rows keep their v1 schema_version on the events
 * table; consumers should treat them as "missing the v2 fields".
 */
import type { Database as BunDatabase } from "bun:sqlite";

import {
  SCHEMA_VERSION,
  asRawLine,
  approximateSize,
  extractApiError,
  extractApiRequest,
  extractAutoCompact,
  extractTurnDuration,
  extractUserMessage,
  parseMcpServerName,
  strOrNull,
  type EventType,
  type RawLine,
} from "./jsonl-payload.ts";

export type NormalizeContext = {
  db: BunDatabase;
  userId: string;
  machineId: string;
  provider: string; // "claude_code" for v0.1
};

export type NormalizeResult = { inserted: number; skipped: number };

/**
 * Insert events for a parsed JSONL line. Tolerates missing fields,
 * unknown line types, and re-ingestion (idempotent).
 */
export function normalizeAndInsert(
  ctx: NormalizeContext,
  rawAny: unknown,
): NormalizeResult {
  const raw = asRawLine(rawAny);
  if (!raw) return { inserted: 0, skipped: 1 };

  const eventId = strOrNull(raw.uuid);
  const timestamp = strOrNull(raw.timestamp);
  if (!eventId || !timestamp) return { inserted: 0, skipped: 1 };

  const sessionId = strOrNull(raw.sessionId);
  let inserted = 0;
  let skipped = 0;

  // ── Assistant turn — the cost-bearing event. ──
  const api = extractApiRequest(raw);
  if (api) {
    inserted += insertEvent(ctx, {
      event_id: eventId,
      timestamp_iso: timestamp,
      session_id: sessionId,
      message_id: api.messageId,
      event_type: "api_request",
      payload: api.payload,
    });
    inserted += insertToolBlocks(ctx, raw, {
      eventId,
      timestamp,
      sessionId,
    });
  } else if (raw.message && (raw.message as { role?: unknown }).role === "user") {
    const user = extractUserMessage(raw);
    if (user) {
      inserted += insertEvent(ctx, {
        event_id: eventId,
        timestamp_iso: timestamp,
        session_id: sessionId,
        message_id: null,
        event_type: "user_message",
        payload: user,
      });
      inserted += insertToolBlocks(ctx, raw, {
        eventId,
        timestamp,
        sessionId,
      });
    } else {
      skipped += 1;
    }
  } else {
    // ── System subtypes we care about. ──
    const compact = extractAutoCompact(raw);
    if (compact) {
      inserted += insertEvent(ctx, {
        event_id: eventId,
        timestamp_iso: timestamp,
        session_id: sessionId,
        message_id: null,
        event_type: "auto_compact",
        payload: compact,
      });
    } else {
      const turn = extractTurnDuration(raw);
      if (turn) {
        inserted += insertEvent(ctx, {
          event_id: eventId,
          timestamp_iso: timestamp,
          session_id: sessionId,
          message_id: null,
          event_type: "turn_duration",
          payload: turn,
        });
      } else {
        const err = extractApiError(raw);
        if (err) {
          inserted += insertEvent(ctx, {
            event_id: eventId,
            timestamp_iso: timestamp,
            session_id: sessionId,
            message_id: null,
            event_type: "api_error",
            payload: err,
          });
        } else {
          // Unknown / uninteresting line type (progress, file-history-
          // snapshot, attachment, custom-title, agent-name, ai-title,
          // permission-mode, last-prompt, queue-operation,
          // away_summary, local_command, stop_hook_summary,
          // informational). Counted as skipped, not an error.
          skipped += 1;
        }
      }
    }
  }

  return { inserted, skipped };
}

/**
 * Extract `tool_use` and `tool_result` child rows from a parent's
 * `message.content` array. Synthesizes a deterministic child event_id
 * so re-ingestion is idempotent.
 *
 * Tool blocks appear on both assistant turns (`tool_use`) and on user
 * turns (`tool_result`), so this is callable from either branch.
 */
function insertToolBlocks(
  ctx: NormalizeContext,
  raw: RawLine,
  parent: { eventId: string; timestamp: string; sessionId: string | null },
): number {
  const msg = raw.message;
  if (!msg) return 0;
  const content = Array.isArray((msg as { content?: unknown }).content)
    ? ((msg as { content: unknown[] }).content)
    : [];
  if (content.length === 0) return 0;

  let inserted = 0;
  let blockIdx = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      blockIdx += 1;
      continue;
    }
    const b = block as Record<string, unknown>;
    const type = strOrNull(b["type"]);

    if (type === "tool_use") {
      const toolName = strOrNull(b["name"]) ?? "";
      const toolUseId = strOrNull(b["id"]) ?? "";
      inserted += insertEvent(ctx, {
        event_id: `${parent.eventId}#tool_use:${blockIdx}`,
        timestamp_iso: parent.timestamp,
        session_id: parent.sessionId,
        message_id: null,
        event_type: "tool_use",
        payload: {
          tool_name: toolName,
          tool_use_id: toolUseId,
          mcp_server_name: parseMcpServerName(toolName),
          parent_event_id: parent.eventId,
        },
      });
    } else if (type === "tool_result") {
      const toolUseId = strOrNull(b["tool_use_id"]) ?? "";
      const success = b["is_error"] !== true;
      const resultContent = b["content"];
      inserted += insertEvent(ctx, {
        event_id: `${parent.eventId}#tool_result:${blockIdx}`,
        timestamp_iso: parent.timestamp,
        session_id: parent.sessionId,
        message_id: null,
        event_type: "tool_result",
        payload: {
          tool_use_id: toolUseId,
          success,
          result_size_bytes: approximateSize(resultContent),
          parent_event_id: parent.eventId,
        },
      });
    }
    blockIdx += 1;
  }
  return inserted;
}

type EventRow = {
  event_id: string;
  timestamp_iso: string;
  session_id: string | null;
  message_id: string | null;
  event_type: EventType;
  payload: unknown;
};

function insertEvent(ctx: NormalizeContext, row: EventRow): number {
  const stmt = ctx.db.prepare(
    `INSERT OR IGNORE INTO events
       (event_id, schema_version, timestamp_iso, user_id, machine_id, provider, session_id, message_id, event_type, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const r = stmt.run(
    row.event_id,
    SCHEMA_VERSION,
    row.timestamp_iso,
    ctx.userId,
    ctx.machineId,
    ctx.provider,
    row.session_id,
    row.message_id,
    row.event_type,
    JSON.stringify(row.payload),
  );
  return r.changes > 0 ? 1 : 0;
}
