/**
 * Lean JSONL → Plouto metadata sync.
 *
 * Pins the guarantees from the sync-approach review: correct lean
 * mapping, metadata-only (no content keys), byte-cursor idempotency +
 * incrementality, the 90-day window, and failure-leaves-cursor-unadvanced.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { runIngestSync } from "../../src/plouto/ingest.ts";
import type { IngestBatch, PloutoClient } from "../../src/plouto/client.ts";
import { LoopDatabase } from "../../src/db.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";

let h: TempLoopHome;
let loop: LoopDatabase;
beforeEach(() => {
  h = makeTempHome();
  loop = LoopDatabase.open();
});
afterEach(() => {
  loop.close();
  h.cleanup();
});

function mockClient() {
  const batches: IngestBatch[] = [];
  let fail = false;
  const client = {
    async ingestSessions(b: IngestBatch) {
      batches.push(b);
      return !fail;
    },
  } as unknown as PloutoClient;
  return { client, batches, setFail: (b: boolean) => { fail = b; } };
}

function writeSession(sessionId: string, lines: object[]): string {
  const dir = path.join(h.claudeHome, "projects", "-home-me-proj");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

const userLine = (uuid: string, ts: string) => ({
  uuid, sessionId: "sess-1", timestamp: ts, cwd: "/home/me/proj",
  gitBranch: "main", version: "1.2.3", type: "user", message: { role: "user" },
});

const asstLine = (uuid: string, ts: string) => ({
  uuid, sessionId: "sess-1", timestamp: ts, cwd: "/home/me/proj",
  gitBranch: "main", version: "1.2.3", type: "assistant", requestId: `r-${uuid}`,
  message: {
    id: `m-${uuid}`, role: "assistant", model: "claude-opus-4-7", stop_reason: "end_turn",
    usage: {
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 },
    },
  },
});

const ALLOWED_TURN_KEYS = new Set([
  "uuid", "session_id", "parent_uuid", "is_sidechain", "turn_type", "timestamp",
  "model_id", "stop_reason", "input_tokens", "output_tokens", "cache_read_tokens",
  "cache_creation_5m_tokens", "cache_creation_1h_tokens", "request_id", "iterations",
  "speed", "service_tier",
]);
const ALLOWED_SESSION_KEYS = new Set([
  "id", "cwd", "project_path_encoded", "git_branch", "cli_version",
  "started_at", "ended_at", "is_subagent", "jsonl_path",
]);

test("uploads session + turn metadata with correct mapping", async () => {
  writeSession("sess-1", [
    userLine("u0", "2026-05-20T09:59:00Z"),
    asstLine("u1", "2026-05-20T10:00:00Z"),
  ]);
  const m = mockClient();
  const res = await runIngestSync(loop.db, m.client);

  expect(res.turnsUploaded).toBe(2);
  const turns = m.batches.flatMap((b) => b.turns);
  const asst = turns.find((t) => t.turn_type === "assistant")!;
  expect(asst.model_id).toBe("claude-opus-4-7");
  expect(asst.input_tokens).toBe(100);
  expect(asst.output_tokens).toBe(50);
  expect(asst.cache_read_tokens).toBe(200);
  expect(asst.cache_creation_5m_tokens).toBe(10);
  expect(asst.cache_creation_1h_tokens).toBe(5);
  expect(asst.request_id).toBe("r-u1");

  const sess = m.batches[0]!.sessions[0]!;
  expect(sess.id).toBe("sess-1");
  expect(sess.cwd).toBe("/home/me/proj");
  expect(sess.project_path_encoded).toBe("-home-me-proj");
  expect(sess.started_at).toBe("2026-05-20T09:59:00Z");
  expect(sess.jsonl_path).toContain("sess-1.jsonl");
  expect(sess.cli_version).toBe("1.2.3");
});

test("metadata-only — every key is on the lean allow-list", async () => {
  writeSession("sess-1", [
    userLine("u0", "2026-05-20T09:59:00Z"),
    asstLine("u1", "2026-05-20T10:00:00Z"),
  ]);
  const m = mockClient();
  await runIngestSync(loop.db, m.client);

  for (const b of m.batches) {
    for (const t of b.turns) {
      for (const k of Object.keys(t)) expect(ALLOWED_TURN_KEYS.has(k)).toBe(true);
    }
    for (const s of b.sessions) {
      for (const k of Object.keys(s)) expect(ALLOWED_SESSION_KEYS.has(k)).toBe(true);
    }
  }
});

test("idempotent — second run uploads nothing", async () => {
  writeSession("sess-1", [asstLine("u1", "2026-05-20T10:00:00Z")]);
  const m = mockClient();
  await runIngestSync(loop.db, m.client);
  m.batches.length = 0;

  const res2 = await runIngestSync(loop.db, m.client);
  expect(res2.turnsUploaded).toBe(0);
  expect(m.batches.length).toBe(0);
});

test("incremental — only newly-appended turns upload", async () => {
  const file = writeSession("sess-1", [asstLine("u1", "2026-05-20T10:00:00Z")]);
  const m = mockClient();
  await runIngestSync(loop.db, m.client);
  m.batches.length = 0;

  fs.appendFileSync(file, JSON.stringify(asstLine("u2", "2026-05-20T10:05:00Z")) + "\n");
  const res = await runIngestSync(loop.db, m.client);
  expect(res.turnsUploaded).toBe(1);
  expect(m.batches.flatMap((b) => b.turns).map((t) => t.uuid)).toEqual(["u2"]);
});

test("90-day window — files older than 90d are skipped", async () => {
  const file = writeSession("sess-old", [asstLine("u1", "2026-01-01T10:00:00Z")]);
  const old = (Date.now() - 100 * 86_400_000) / 1000;
  fs.utimesSync(file, old, old);
  const m = mockClient();
  const res = await runIngestSync(loop.db, m.client);
  expect(res.turnsUploaded).toBe(0);
});

test("failed upload leaves the cursor unadvanced → retries next run", async () => {
  writeSession("sess-1", [asstLine("u1", "2026-05-20T10:00:00Z")]);
  const m = mockClient();
  m.setFail(true);
  const r1 = await runIngestSync(loop.db, m.client);
  expect(r1.turnsUploaded).toBe(0); // POST failed

  m.batches.length = 0;
  m.setFail(false);
  const r2 = await runIngestSync(loop.db, m.client);
  expect(r2.turnsUploaded).toBe(1); // retried, cursor had not advanced
});

test("git identity is well-formed when present", async () => {
  writeSession("sess-1", [asstLine("u1", "2026-05-20T10:00:00Z")]);
  const m = mockClient();
  await runIngestSync(loop.db, m.client);
  const id = m.batches[0]!.agent_identity;
  // best-effort (depends on git config in the env); if present it's an email
  if (id !== undefined) expect(typeof id.email).toBe("string");
});
