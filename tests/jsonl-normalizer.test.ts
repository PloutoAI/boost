import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LoopDatabase } from "../src/db.ts";
import { normalizeAndInsert } from "../src/data/jsonl-normalizer.ts";
import {
  SCHEMA_VERSION,
  asRawLine,
  extractApiError,
  extractApiRequest,
  extractAutoCompact,
  extractTurnDuration,
  parseMcpServerName,
} from "../src/data/jsonl-payload.ts";
import { makeTempHome, type TempLoopHome } from "./helpers/temp-loop-home.ts";

/**
 * Tests run against real Claude Code JSONL shapes captured from the
 * local logs (sanitized — names, paths, request ids, uuids replaced).
 * Each fixture is a single JSONL line in JSON form; the loader below
 * reads them all into memory so each test stays declarative.
 *
 * Naming convention: tests/fixtures/jsonl/<kind>.json
 */

const FIXTURE_DIR = path.join(__dirname, "fixtures", "jsonl");

function loadFixture(name: string): Record<string, unknown> {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ctxFor(handle: ReturnType<typeof LoopDatabase.open>) {
  return { db: handle.db, userId: "u", machineId: "m", provider: "claude_code" };
}

function readRows(handle: ReturnType<typeof LoopDatabase.open>) {
  return handle.db
    .query<
      {
        event_id: string;
        event_type: string;
        session_id: string | null;
        message_id: string | null;
        schema_version: number;
        payload_json: string;
      },
      []
    >(
      "SELECT event_id, event_type, session_id, message_id, schema_version, payload_json FROM events ORDER BY timestamp_iso, event_id",
    )
    .all();
}

let h: TempLoopHome;
beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => h.cleanup());

// ─── Extractor unit tests (pure, no DB) ──────────────────────────

test("extractor: assistant Opus 4.6 — cache_creation object + iterations array", () => {
  const raw = asRawLine(loadFixture("assistant-opus-4-6"));
  const out = extractApiRequest(raw!);
  expect(out).not.toBeNull();
  const p = out!.payload;
  expect(out!.messageId).toBe("msg_015uJyinQczJhS73qf3nKy3R");
  expect(p.model).toBe("claude-opus-4-6");
  expect(p.input_tokens).toBe(3);
  expect(p.output_tokens).toBe(53);
  expect(p.cache_creation_5m_tokens).toBe(0);
  expect(p.cache_creation_1h_tokens).toBe(4724);
  // Sums the 5m/1h subfields (prefers the object over the flat field).
  expect(p.cache_creation_tokens).toBe(4724);
  expect(p.cache_read_tokens).toBe(12139);
  // Length of the iterations array = the agentic-loop fan-out count.
  expect(p.iterations).toBe(3);
  expect(p.is_sidechain).toBe(false);
  expect(p.request_id).toBe("req_011Ca2JtYkt9NyWiTL2");
  expect(p.prompt_id).toBe("prompt-abc");
  expect(p.service_tier).toBe("standard");
  expect(p.speed).toBe("standard");
  expect(p.stop_reason).toBe("end_turn");
});

test("extractor: legacy Sonnet line — no cache_creation object, flat field only", () => {
  const raw = asRawLine(loadFixture("assistant-sonnet-legacy"));
  const out = extractApiRequest(raw!);
  expect(out).not.toBeNull();
  const p = out!.payload;
  // Falls back to the top-level number when the object is absent.
  expect(p.cache_creation_5m_tokens).toBe(0);
  expect(p.cache_creation_1h_tokens).toBe(0);
  expect(p.cache_creation_tokens).toBe(200);
  // No iterations array → fall back to 1 (the turn itself).
  expect(p.iterations).toBe(1);
  expect(p.request_id).toBeNull();
  expect(p.prompt_id).toBeNull();
});

test("extractor: subagent line — is_sidechain captured", () => {
  const raw = asRawLine(loadFixture("assistant-subagent"));
  const out = extractApiRequest(raw!);
  expect(out!.payload.is_sidechain).toBe(true);
  // Subagent had only 5m cache creation.
  expect(out!.payload.cache_creation_5m_tokens).toBe(50);
  expect(out!.payload.cache_creation_1h_tokens).toBe(0);
  expect(out!.payload.cache_creation_tokens).toBe(50);
});

test("extractor: system/compact_boundary → AutoCompactPayload", () => {
  const raw = asRawLine(loadFixture("system-compact-boundary"));
  const out = extractAutoCompact(raw!);
  expect(out).not.toBeNull();
  expect(out!.trigger).toBe("manual");
  expect(out!.pre_tokens).toBe(594341);
  expect(out!.post_tokens).toBe(10241);
  expect(out!.duration_ms).toBe(142434);
  expect(out!.pre_compact_tool_count).toBe(3);
});

test("extractor: system/turn_duration → TurnDurationPayload", () => {
  const raw = asRawLine(loadFixture("system-turn-duration"));
  const out = extractTurnDuration(raw!);
  expect(out).not.toBeNull();
  expect(out!.duration_ms).toBe(130499);
  expect(out!.message_count).toBe(66);
});

test("extractor: system/api_error → ApiErrorPayload (no free-text error body)", () => {
  const raw = asRawLine(loadFixture("system-api-error"));
  const out = extractApiError(raw!);
  expect(out).not.toBeNull();
  expect(out!.retry_attempt).toBe(1);
  expect(out!.max_retries).toBe(10);
  expect(Math.round(out!.retry_in_ms)).toBe(510);
  expect(out!.level).toBe("error");
});

test("extractor: non-matching subtype → null (negative cases)", () => {
  const raw = asRawLine(loadFixture("assistant-opus-4-6"));
  expect(extractAutoCompact(raw!)).toBeNull();
  expect(extractTurnDuration(raw!)).toBeNull();
  expect(extractApiError(raw!)).toBeNull();
});

// ─── Normalizer integration tests (DB-backed, end-to-end) ───────

test("normalize: Opus assistant turn writes one api_request row with v2 payload", () => {
  const handle = LoopDatabase.open();
  const r = normalizeAndInsert(ctxFor(handle), loadFixture("assistant-opus-4-6"));
  expect(r.inserted).toBe(1);

  const rows = readRows(handle);
  expect(rows.length).toBe(1);
  const row = rows[0]!;
  expect(row.event_type).toBe("api_request");
  expect(row.schema_version).toBe(SCHEMA_VERSION);
  const payload = JSON.parse(row.payload_json);
  expect(payload.iterations).toBe(3);
  expect(payload.cache_creation_5m_tokens).toBe(0);
  expect(payload.cache_creation_1h_tokens).toBe(4724);
  expect(payload.is_sidechain).toBe(false);
  expect(payload.request_id).toBe("req_011Ca2JtYkt9NyWiTL2");
  // Back-compat keys summary.ts queries on:
  expect(payload.input_tokens).toBe(3);
  expect(payload.output_tokens).toBe(53);
  expect(payload.cache_creation_tokens).toBe(4724);
  expect(payload.cache_read_tokens).toBe(12139);
  expect(payload.model).toBe("claude-opus-4-6");
  handle.close();
});

test("normalize: assistant with tool_use blocks writes parent + child rows", () => {
  const handle = LoopDatabase.open();
  normalizeAndInsert(ctxFor(handle), loadFixture("assistant-with-tool-blocks"));

  const rows = readRows(handle);
  // 1 api_request + 2 tool_use children.
  expect(rows.length).toBe(3);
  const toolUses = rows.filter((r) => r.event_type === "tool_use");
  expect(toolUses.length).toBe(2);

  const mcp = JSON.parse(toolUses.find((r) => JSON.parse(r.payload_json).tool_name?.startsWith("mcp__"))!.payload_json);
  expect(mcp.mcp_server_name).toBe("github-mcp");
  expect(mcp.parent_event_id).toBe("b1b2b3b4-1111-2222-3333-000000000004");

  const read = JSON.parse(toolUses.find((r) => JSON.parse(r.payload_json).tool_name === "Read")!.payload_json);
  expect(read.mcp_server_name).toBeNull();

  handle.close();
});

test("normalize: user turn with tool_results writes child rows with success flag + size", () => {
  const handle = LoopDatabase.open();
  normalizeAndInsert(ctxFor(handle), loadFixture("user-with-tool-results"));

  const rows = readRows(handle);
  expect(rows.length).toBe(3); // user_message + 2 tool_result
  const results = rows
    .filter((r) => r.event_type === "tool_result")
    .map((r) => JSON.parse(r.payload_json));
  const ok = results.find((p) => p.tool_use_id === "toolu_01")!;
  expect(ok.success).toBe(true);
  expect(ok.result_size_bytes).toBeGreaterThan(0);

  const err = results.find((p) => p.tool_use_id === "toolu_02")!;
  expect(err.success).toBe(false);

  handle.close();
});

test("normalize: compact_boundary, turn_duration, api_error each write a row", () => {
  const handle = LoopDatabase.open();
  const ctx = ctxFor(handle);
  normalizeAndInsert(ctx, loadFixture("system-compact-boundary"));
  normalizeAndInsert(ctx, loadFixture("system-turn-duration"));
  normalizeAndInsert(ctx, loadFixture("system-api-error"));

  const rows = readRows(handle);
  expect(rows.map((r) => r.event_type).sort()).toEqual([
    "api_error",
    "auto_compact",
    "turn_duration",
  ]);
  // Each carries its typed payload.
  const compact = JSON.parse(rows.find((r) => r.event_type === "auto_compact")!.payload_json);
  expect(compact.trigger).toBe("manual");
  expect(compact.pre_tokens).toBe(594341);
  handle.close();
});

test("normalize: unknown line types are skipped, not errored", () => {
  const handle = LoopDatabase.open();
  const r = normalizeAndInsert(ctxFor(handle), loadFixture("skipped-progress"));
  expect(r.inserted).toBe(0);
  expect(r.skipped).toBe(1);
  expect(readRows(handle).length).toBe(0);
  handle.close();
});

test("normalize: missing uuid or timestamp is a soft skip", () => {
  const handle = LoopDatabase.open();
  const ctx = ctxFor(handle);
  expect(normalizeAndInsert(ctx, {}).skipped).toBe(1);
  expect(normalizeAndInsert(ctx, { uuid: "x" }).skipped).toBe(1);
  expect(normalizeAndInsert(ctx, { timestamp: "now" }).skipped).toBe(1);
  expect(readRows(handle).length).toBe(0);
  handle.close();
});

// ─── Idempotency + dedup ─────────────────────────────────────────

test("idempotent: re-ingesting the same line a second time inserts nothing new", () => {
  const handle = LoopDatabase.open();
  const ctx = ctxFor(handle);
  const fixtures = [
    "assistant-opus-4-6",
    "assistant-with-tool-blocks",
    "user-with-tool-results",
    "system-compact-boundary",
    "system-turn-duration",
    "system-api-error",
  ];

  let firstPass = 0;
  for (const f of fixtures) firstPass += normalizeAndInsert(ctx, loadFixture(f)).inserted;
  expect(firstPass).toBeGreaterThan(0);

  let secondPass = 0;
  for (const f of fixtures) secondPass += normalizeAndInsert(ctx, loadFixture(f)).inserted;
  expect(secondPass).toBe(0);

  // DB state identical to first-pass: row count stable, payloads stable.
  const rowsAfter = readRows(handle);
  expect(rowsAfter.length).toBe(firstPass);
  handle.close();
});

test("dedup: same message.id with different uuid → second api_request is blocked", () => {
  const handle = LoopDatabase.open();
  const ctx = ctxFor(handle);
  const raw = loadFixture("assistant-opus-4-6");
  const r1 = normalizeAndInsert(ctx, raw);
  const r2 = normalizeAndInsert(ctx, { ...raw, uuid: "deadbeef-0000-0000-0000-000000000000" });
  expect(r1.inserted).toBeGreaterThan(0);
  // The api_request row is blocked by the unique message_id index;
  // tool children would re-insert under their own event_ids though
  // this fixture has none, so we expect zero.
  expect(r2.inserted).toBe(0);
  handle.close();
});

test("parseMcpServerName: extracts server slug from MCP tool names", () => {
  expect(parseMcpServerName("mcp__github-mcp__list_issues")).toBe("github-mcp");
  expect(parseMcpServerName("Read")).toBeNull();
  expect(parseMcpServerName("mcp__only_one")).toBeNull();
});
