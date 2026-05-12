/**
 * Typed payload shapes and pure extractors for Claude Code JSONL lines.
 *
 * Why a separate module?
 *
 * 1. **Reproducibility.** Every event row written to `events.payload_json`
 *    has one and only one shape per `event_type`. Defining those shapes
 *    here (instead of inlining `{ k: v, ... }` literals in the
 *    normalizer) lets the test suite assert on a typed contract and lets
 *    consumers (summary.ts, detectors) read by field name without
 *    inspecting normalizer source.
 *
 * 2. **Schema versioning.** When a payload shape changes we bump
 *    `SCHEMA_VERSION` here and consumers can branch on it. Today's bump
 *    (v1 → v2) adds the cache-creation 5m/1h split, agentic-loop
 *    iterations, request_id / prompt_id / is_sidechain on api_request,
 *    plus three new system event types (auto_compact, turn_duration,
 *    api_error) the original normalizer dropped.
 *
 * 3. **Privacy boundary.** Every extractor here is pure and only reads
 *    a numeric / boolean / strict-enum / opaque-id field. Free-text
 *    fields (`error.message`, `compactMetadata.preCompactDiscoveredTools`
 *    content, `last-prompt` bodies, attachment names) are never
 *    extracted. The promise is that nothing leaving this module carries
 *    user prose.
 *
 * 4. **Idempotency.** Extractors are deterministic: same input → same
 *    output. The normalizer's idempotency (same line ingested twice
 *    produces no new rows) is a property of `INSERT OR IGNORE` plus
 *    stable `event_id` derivation, both of which depend on extractors
 *    returning identical payloads. Pure functions guarantee that.
 */

/** Bumped any time the shape of any payload below changes. v1 → v2 in
 *  this commit. Old rows keep their v1 schema_version on the events
 *  table — readers should treat v1 rows as "missing the new fields"
 *  rather than re-extracting. */
export const SCHEMA_VERSION = 2;

// ── Event type discriminator. One string per row, indexed in DB. ──
export type EventType =
  | "api_request"      // assistant turn (the cost-bearing event)
  | "user_message"     // user prompt turn
  | "tool_use"         // child of an api_request — one block per call
  | "tool_result"      // child of a user_message — one block per result
  | "auto_compact"     // system.subtype = compact_boundary
  | "turn_duration"    // system.subtype = turn_duration
  | "api_error";       // system.subtype = api_error (retry)

// ─── Payload shapes (kept stable; bump SCHEMA_VERSION when changing) ───

export type ApiRequestPayload = {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  /** Sum of `cache_creation.ephemeral_5m_input_tokens` and `..._1h_...`,
   *  or `usage.cache_creation_input_tokens` on older lines. */
  cache_creation_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  cache_read_tokens: number;
  /** Always 0 in current data — thinking blocks fold their tokens into
   *  output_tokens. Kept as a field so detectors don't crash if
   *  Anthropic ever surfaces it as its own usage entry. */
  reasoning_tokens: number;
  web_search_requests: number;
  /** `usage.speed`: "fast" | "standard" | null. Surfaces priority-tier
   *  upcharges on Opus 4.6+. */
  speed: string | null;
  /** `usage.service_tier`: "standard" | "batch" | null. */
  service_tier: string | null;
  stop_reason: string | null;
  /** Length of `usage.iterations`, the agentic-loop mini-turn array
   *  Opus 4.6+ emits for parallel tool calls inside one assistant turn.
   *  >1 is a strong signal of tool fan-out (and therefore cost). */
  iterations: number;
  /** From line root, not message. True iff this turn ran inside a
   *  Task() subagent — lets us attribute subagent cost back to the
   *  spawning session. */
  is_sidechain: boolean;
  /** The HTTP request id; groups retries of the same underlying call. */
  request_id: string | null;
  /** Groups one user-turn's fan-out across multiple assistant turns.
   *  Different from sessionId. */
  prompt_id: string | null;
  cwd: string | null;
  git_branch: string | null;
  parent_uuid: string | null;
};

export type UserMessagePayload = {
  cwd: string | null;
  prompt_id: string | null;
  is_sidechain: boolean;
};

export type ToolUsePayload = {
  tool_name: string;
  tool_use_id: string;
  mcp_server_name: string | null;
  parent_event_id: string;
};

export type ToolResultPayload = {
  tool_use_id: string;
  success: boolean;
  result_size_bytes: number;
  parent_event_id: string;
};

export type AutoCompactPayload = {
  trigger: string;          // "auto" | "manual"
  pre_tokens: number;
  post_tokens: number;
  duration_ms: number;
  pre_compact_tool_count: number;
};

export type TurnDurationPayload = {
  duration_ms: number;
  message_count: number;
};

export type ApiErrorPayload = {
  retry_attempt: number;
  max_retries: number;
  retry_in_ms: number;
  level: string | null;
};

// ─── Pure extractors ────────────────────────────────────────────────
//
// Each `extractX(raw)` reads its event from the raw line and returns
// either a typed payload or null. Extractors must:
//  - Be pure (no I/O, no time-of-day).
//  - Be tolerant of missing fields — fall back to typed zeros / nulls.
//  - Never read free-form prose fields. If a future field shape changes,
//    a fixture-based test will catch it before it ships to users.

export function extractApiRequest(
  raw: RawLine,
): { payload: ApiRequestPayload; messageId: string | null } | null {
  if (!raw.message || raw.message.role !== "assistant") return null;
  const msg = raw.message;
  const usage = isObject(msg.usage) ? (msg.usage as Record<string, unknown>) : {};
  const serverToolUse = isObject(usage["server_tool_use"])
    ? (usage["server_tool_use"] as Record<string, unknown>)
    : {};
  const cacheCreation = isObject(usage["cache_creation"])
    ? (usage["cache_creation"] as Record<string, unknown>)
    : {};

  const ephemeral5m = numOr(cacheCreation["ephemeral_5m_input_tokens"], 0);
  const ephemeral1h = numOr(cacheCreation["ephemeral_1h_input_tokens"], 0);
  // Prefer the object subfields (newer); fall back to the flat
  // top-level number that older Sonnet lines still use.
  const cacheCreationTokens =
    ephemeral5m + ephemeral1h > 0
      ? ephemeral5m + ephemeral1h
      : numOr(usage["cache_creation_input_tokens"], 0);

  const iterationsArray = Array.isArray(usage["iterations"])
    ? (usage["iterations"] as unknown[])
    : null;
  // Older lines surface no `iterations` key at all; count = 1 (the turn
  // itself). When the array is present, its length is the count of
  // agentic-loop iterations.
  const iterations = iterationsArray ? iterationsArray.length : 1;

  return {
    payload: {
      model: strOrNull(msg.model),
      input_tokens: numOr(usage["input_tokens"], 0),
      output_tokens: numOr(usage["output_tokens"], 0),
      cache_creation_tokens: cacheCreationTokens,
      cache_creation_5m_tokens: ephemeral5m,
      cache_creation_1h_tokens: ephemeral1h,
      cache_read_tokens: numOr(usage["cache_read_input_tokens"], 0),
      reasoning_tokens: numOr(usage["reasoning_tokens"] ?? usage["thinking_tokens"], 0),
      web_search_requests: numOr(serverToolUse["web_search_requests"], 0),
      speed: strOrNull(usage["speed"]),
      service_tier: strOrNull(usage["service_tier"]),
      stop_reason: strOrNull(msg.stop_reason),
      iterations,
      is_sidechain: raw.isSidechain === true,
      request_id: strOrNull(raw.requestId),
      prompt_id: strOrNull(raw.promptId),
      cwd: strOrNull(raw.cwd),
      git_branch: strOrNull(raw.gitBranch),
      parent_uuid: strOrNull(raw.parentUuid),
    },
    messageId: strOrNull(msg.id),
  };
}

export function extractUserMessage(raw: RawLine): UserMessagePayload | null {
  if (!raw.message || raw.message.role !== "user") return null;
  return {
    cwd: strOrNull(raw.cwd),
    prompt_id: strOrNull(raw.promptId),
    is_sidechain: raw.isSidechain === true,
  };
}

export function extractAutoCompact(raw: RawLine): AutoCompactPayload | null {
  if (raw.type !== "system" || raw.subtype !== "compact_boundary") return null;
  const meta = isObject(raw.compactMetadata)
    ? (raw.compactMetadata as Record<string, unknown>)
    : {};
  const tools = Array.isArray(meta["preCompactDiscoveredTools"])
    ? (meta["preCompactDiscoveredTools"] as unknown[]).length
    : 0;
  return {
    trigger: strOr(meta["trigger"], "unknown"),
    pre_tokens: numOr(meta["preTokens"], 0),
    post_tokens: numOr(meta["postTokens"], 0),
    duration_ms: numOr(meta["durationMs"], 0),
    pre_compact_tool_count: tools,
  };
}

export function extractTurnDuration(raw: RawLine): TurnDurationPayload | null {
  if (raw.type !== "system" || raw.subtype !== "turn_duration") return null;
  return {
    duration_ms: numOr(raw.durationMs, 0),
    message_count: numOr(raw.messageCount, 0),
  };
}

export function extractApiError(raw: RawLine): ApiErrorPayload | null {
  if (raw.type !== "system" || raw.subtype !== "api_error") return null;
  return {
    retry_attempt: numOr(raw.retryAttempt, 0),
    max_retries: numOr(raw.maxRetries, 0),
    retry_in_ms: numOr(raw.retryInMs, 0),
    level: strOrNull(raw.level),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Loose view of a raw line. Every field that's actually a string in
 *  the wire format is typed as `unknown` so the extractors can guard
 *  it; the alternative (type as `string`) would let parsing bugs slip
 *  through quietly. */
export type RawLine = {
  uuid?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  type?: unknown;
  subtype?: unknown;
  message?: { id?: unknown; role?: unknown; model?: unknown; stop_reason?: unknown; usage?: unknown; content?: unknown } | undefined;
  cwd?: unknown;
  gitBranch?: unknown;
  parentUuid?: unknown;
  requestId?: unknown;
  promptId?: unknown;
  isSidechain?: unknown;
  compactMetadata?: unknown;
  durationMs?: unknown;
  messageCount?: unknown;
  retryAttempt?: unknown;
  maxRetries?: unknown;
  retryInMs?: unknown;
  level?: unknown;
};

export function asRawLine(o: unknown): RawLine | null {
  if (typeof o !== "object" || o === null) return null;
  return o as RawLine;
}

export function strOrNull(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}

export function strOr<T>(x: unknown, fallback: T): string | T {
  return typeof x === "string" ? x : fallback;
}

export function numOr(x: unknown, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** MCP tool names follow `mcp__<server>__<tool>`. Returns the server
 *  slug, or null for non-MCP tools. Re-exported through the normalizer
 *  for backward compatibility with consumers that import it from
 *  there. */
export function parseMcpServerName(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  return rest.slice(0, sep);
}

/** UTF-8 byte size of an arbitrary value. Used to size `tool_result`
 *  payloads without storing the content itself. */
export function approximateSize(x: unknown): number {
  if (typeof x === "string") return Buffer.byteLength(x, "utf8");
  if (x === null || x === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(x), "utf8");
  } catch {
    return 0;
  }
}
