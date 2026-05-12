import { test, expect, beforeEach, afterEach } from "bun:test";
import strategy from "../../src/strategies/model-mix-advisory.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";
import {
  makeDetectorContext,
  seedApiRequest,
  singleFinding,
  type FakeContext,
} from "../helpers/detector-context.ts";

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

test("returns null in cold start (< 7 days of data)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 3,
    seed: (db) => seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso(), model: "claude-opus" }),
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when total spend is below the noise floor", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) =>
      seedApiRequest(db, {
        eventId: "e1",
        timestamp: yesterdayIso(),
        inputTokens: 50,
        outputTokens: 50,
        model: "claude-opus",
      }),
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("flags advisory when one model dominates ≥ 80% of uncached spend", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // 9 Opus requests at 20k tokens each = 180k
      for (let i = 0; i < 9; i++) {
        seedApiRequest(db, {
          eventId: `op${i}`,
          timestamp: yesterdayIso(),
          inputTokens: 5_000,
          outputTokens: 5_000,
          cacheCreationTokens: 10_000,
          model: "claude-opus-4-7",
        });
      }
      // 1 Sonnet request — 20k tokens (so Opus = 90% of uncached)
      seedApiRequest(db, {
        eventId: "so1",
        timestamp: yesterdayIso(),
        inputTokens: 5_000,
        outputTokens: 5_000,
        cacheCreationTokens: 10_000,
        model: "claude-sonnet-4-6",
      });
    },
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.affectedItems[0]).toContain("opus");
  expect(finding.severity).toBe("medium"); // 90% < 95% threshold for high
  expect(finding.fixes).toBeUndefined(); // advisory: no fixes
  const sig = finding.evidence.signals as { breakdown: Array<{ model: string }>; dominantSharePct: number };
  expect(sig.breakdown.length).toBeGreaterThanOrEqual(2);
  expect(sig.dominantSharePct).toBeGreaterThan(80);
});

test("severity escalates to high at ≥ 95% concentration", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // 99 Opus + 1 Sonnet — Opus ≈ 99%
      for (let i = 0; i < 99; i++) {
        seedApiRequest(db, {
          eventId: `op${i}`,
          timestamp: yesterdayIso(),
          inputTokens: 1_000,
          outputTokens: 1_000,
          model: "claude-opus-4-7",
        });
      }
      seedApiRequest(db, {
        eventId: "so1",
        timestamp: yesterdayIso(),
        inputTokens: 1_000,
        outputTokens: 1_000,
        model: "claude-sonnet-4-6",
      });
    },
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.severity).toBe("high");
});

test("does NOT flag when the dominant model is already cheap (Haiku/Sonnet)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let i = 0; i < 10; i++) {
        seedApiRequest(db, {
          eventId: `h${i}`,
          timestamp: yesterdayIso(),
          inputTokens: 5_000,
          outputTokens: 5_000,
          cacheCreationTokens: 10_000,
          model: "claude-haiku-4-5",
        });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("does NOT flag when the user is already on a healthy mix (no model > 80%)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // 60% Opus, 40% Sonnet — healthy mix.
      for (let i = 0; i < 6; i++) {
        seedApiRequest(db, {
          eventId: `op${i}`,
          timestamp: yesterdayIso(),
          inputTokens: 5_000,
          outputTokens: 5_000,
          cacheCreationTokens: 10_000,
          model: "claude-opus-4-7",
        });
      }
      for (let i = 0; i < 4; i++) {
        seedApiRequest(db, {
          eventId: `so${i}`,
          timestamp: yesterdayIso(),
          inputTokens: 5_000,
          outputTokens: 5_000,
          cacheCreationTokens: 10_000,
          model: "claude-sonnet-4-6",
        });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("savings percentage is clamped (low-data weeks can't produce >100%)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) =>
      seedApiRequest(db, {
        eventId: "op1",
        timestamp: yesterdayIso(),
        inputTokens: 50_000,
        outputTokens: 50_000,
        cacheCreationTokens: 100_000,
        model: "claude-opus-4-7",
      }),
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  if (finding.estimatedPercentOfWeeklyUsage !== null) {
    expect(finding.estimatedPercentOfWeeklyUsage).toBeLessThanOrEqual(99.9);
  }
});
