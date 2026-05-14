import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import strategy from "../../src/strategies/shell-output-verbose-advisory.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";
import {
  makeDetectorContext,
  seedApiRequest,
  type FakeContext,
} from "../helpers/detector-context.ts";
import type { Finding } from "../../src/types.ts";

let h: TempLoopHome;
let f: FakeContext | null = null;

beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => {
  if (f) f.cleanup();
  f = null;
  h.cleanup();
});

const yesterdayIso = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

/** Insert a Bash tool_use + matching tool_result pair in one go. */
function seedBashCall(
  db: Database,
  args: {
    eventId: string;
    timestamp: string;
    stem: string;
    responseBytes: number;
    success?: boolean;
  },
): void {
  const toolUseId = `tu_${args.eventId}`;
  db.prepare(
    `INSERT INTO events (event_id, schema_version, timestamp_iso, user_id, machine_id, provider, session_id, message_id, event_type, payload_json)
     VALUES (?, 1, ?, 'u', 'm', 'claude_code', 's1', NULL, 'tool_use', ?)`,
  ).run(
    `${args.eventId}#u`,
    args.timestamp,
    JSON.stringify({
      tool_name: "Bash",
      tool_use_id: toolUseId,
      mcp_server_name: null,
      bash_command_stem: args.stem,
      parent_event_id: "p",
    }),
  );
  db.prepare(
    `INSERT INTO events (event_id, schema_version, timestamp_iso, user_id, machine_id, provider, session_id, message_id, event_type, payload_json)
     VALUES (?, 1, ?, 'u', 'm', 'claude_code', 's1', NULL, 'tool_result', ?)`,
  ).run(
    `${args.eventId}#r`,
    args.timestamp,
    JSON.stringify({
      tool_use_id: toolUseId,
      success: args.success ?? true,
      result_size_bytes: args.responseBytes,
      parent_event_id: "p",
    }),
  );
}

/** Insert enough api_request volume for the share calculation to be non-trivial. */
function seedWeeklySpend(db: Database, uncachedTokens: number): void {
  seedApiRequest(db, {
    eventId: "spend1",
    timestamp: yesterdayIso(),
    inputTokens: Math.floor(uncachedTokens / 2),
    outputTokens: Math.floor(uncachedTokens / 2),
  });
}

test("returns null during cold start (< 7 days of data)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 3,
    seed: (db) => {
      seedWeeklySpend(db, 100_000);
      for (let i = 0; i < 20; i++) {
        seedBashCall(db, { eventId: `e${i}`, timestamp: yesterdayIso(), stem: "git", responseBytes: 5000 });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when no bash tool calls exist", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => seedWeeklySpend(db, 100_000),
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when responses are all below MIN_RESPONSE_BYTES (2000)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      seedWeeklySpend(db, 50_000);
      for (let i = 0; i < 50; i++) {
        seedBashCall(db, { eventId: `e${i}`, timestamp: yesterdayIso(), stem: "echo", responseBytes: 100 });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when fewer than MIN_EXPENSIVE_CALLS qualifying calls (5)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      seedWeeklySpend(db, 10_000);
      for (let i = 0; i < 3; i++) {
        seedBashCall(db, { eventId: `e${i}`, timestamp: yesterdayIso(), stem: "git", responseBytes: 5000 });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when share is below 3% of weekly uncached", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // 10M uncached tokens — 50KB of shell output ≈ 12.5k tokens ≈ 0.1% share.
      seedWeeklySpend(db, 10_000_000);
      for (let i = 0; i < 10; i++) {
        seedBashCall(db, { eventId: `e${i}`, timestamp: yesterdayIso(), stem: "git", responseBytes: 5000 });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("ignores failed (is_error) tool_results", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      seedWeeklySpend(db, 100_000);
      for (let i = 0; i < 30; i++) {
        seedBashCall(db, {
          eventId: `e${i}`,
          timestamp: yesterdayIso(),
          stem: "git",
          responseBytes: 5000,
          success: false,
        });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("fires when verbose responses meet share threshold and top stems are ranked by bytes", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // 100k weekly uncached → 3% = 3k tokens = 12k bytes. We'll send much more.
      seedWeeklySpend(db, 100_000);
      // git: 20 calls × 5KB = 100KB (top)
      for (let i = 0; i < 20; i++) {
        seedBashCall(db, { eventId: `g${i}`, timestamp: yesterdayIso(), stem: "git", responseBytes: 5000 });
      }
      // docker: 10 calls × 3KB = 30KB
      for (let i = 0; i < 10; i++) {
        seedBashCall(db, { eventId: `d${i}`, timestamp: yesterdayIso(), stem: "docker", responseBytes: 3000 });
      }
      // cargo: 5 calls × 8KB = 40KB
      for (let i = 0; i < 5; i++) {
        seedBashCall(db, { eventId: `c${i}`, timestamp: yesterdayIso(), stem: "cargo", responseBytes: 8000 });
      }
    },
  });
  const result = strategy.detect(f.ctx) as Finding | null;
  expect(result).not.toBeNull();
  const f1 = result as Finding;
  expect(f1.strategyId).toBe("shell-output-verbose-advisory");
  expect(f1.category).toBe("trade-offs");
  expect(f1.affectedItems).toEqual(["git", "cargo", "docker"]);
  const sig = f1.evidence.signals as {
    totalCalls?: number;
    totalBytes?: number;
    topStems?: Array<{ stem: string; calls: number; bytes: number }>;
  };
  expect(sig.totalCalls).toBe(35);
  expect(sig.totalBytes).toBe(170_000);
  expect(sig.topStems?.[0]?.stem).toBe("git");
  expect(sig.topStems?.[0]?.bytes).toBe(100_000);
});

test("severity is medium when share ≥10%, low otherwise", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // 50k weekly uncached, 200k bytes = 50k tokens = 100% share → medium.
      seedWeeklySpend(db, 50_000);
      for (let i = 0; i < 20; i++) {
        seedBashCall(db, { eventId: `e${i}`, timestamp: yesterdayIso(), stem: "git", responseBytes: 10_000 });
      }
    },
  });
  const r = strategy.detect(f.ctx) as Finding;
  expect(r.severity).toBe("medium");
});
