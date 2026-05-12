import { test, expect, beforeEach, afterEach } from "bun:test";
import strategy from "../../src/strategies/auto-compact-overuse-advisory.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";
import {
  makeDetectorContext,
  seedAutoCompact,
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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function asArray(r: Finding | Finding[] | null): Finding[] {
  if (r === null) return [];
  return Array.isArray(r) ? r : [r];
}

const recentIso = (offsetMs = 0): string => new Date(Date.now() - DAY + offsetMs).toISOString();

test("returns null during cold start", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 3,
    seed: (db) => {
      for (let i = 0; i < 5; i++) {
        seedAutoCompact(db, { eventId: `e${i}`, timestamp: recentIso(i * HOUR), sessionId: "s1" });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when no auto_compact events exist", () => {
  f = makeDetectorContext({ daysOfDataAvailable: 30 });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when a session has < 3 compacts", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      seedAutoCompact(db, { eventId: "e1", timestamp: recentIso(0), sessionId: "s1" });
      seedAutoCompact(db, { eventId: "e2", timestamp: recentIso(HOUR), sessionId: "s1" });
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("flags a session with exactly 3 compacts → low severity", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let i = 0; i < 3; i++) {
        seedAutoCompact(db, {
          eventId: `e${i}`,
          timestamp: recentIso(i * HOUR),
          sessionId: "s1",
          preTokens: 100_000,
        });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.affectedItems).toEqual(["s1"]);
  expect(findings[0]!.severity).toBe("low");
  expect(findings[0]!.fixes).toBeUndefined();
  const sig = findings[0]!.evidence.signals as {
    compacts: number;
    totalPreTokens: number;
    firstIso: string;
    lastIso: string;
  };
  expect(sig.compacts).toBe(3);
  expect(sig.totalPreTokens).toBe(300_000);
  expect(sig.firstIso).toBeTruthy();
  expect(sig.lastIso).toBeTruthy();
});

test("escalates to medium at 5+ compacts", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let i = 0; i < 5; i++) {
        seedAutoCompact(db, { eventId: `e${i}`, timestamp: recentIso(i * HOUR), sessionId: "s1" });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.severity).toBe("medium");
});

test("escalates to high at 8+ compacts", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let i = 0; i < 8; i++) {
        seedAutoCompact(db, { eventId: `e${i}`, timestamp: recentIso(i * HOUR), sessionId: "s1" });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.severity).toBe("high");
});

test("emits one finding per session and ranks by compact count", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // Session 'few': 3 compacts
      for (let i = 0; i < 3; i++) {
        seedAutoCompact(db, { eventId: `f${i}`, timestamp: recentIso(i * HOUR), sessionId: "few" });
      }
      // Session 'many': 6 compacts → ranked first
      for (let i = 0; i < 6; i++) {
        seedAutoCompact(db, { eventId: `m${i}`, timestamp: recentIso(i * HOUR), sessionId: "many" });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(2);
  expect(findings[0]!.affectedItems[0]).toBe("many");
  expect(findings[1]!.affectedItems[0]).toBe("few");
});

test("caps output to top 5 sessions when more sessions qualify", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let s = 0; s < 8; s++) {
        // s+3 compacts per session — all above threshold, monotonically increasing.
        const count = s + 3;
        for (let i = 0; i < count; i++) {
          seedAutoCompact(db, {
            eventId: `s${s}-${i}`,
            timestamp: recentIso(i * HOUR),
            sessionId: `sess-${s}`,
          });
        }
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(5);
  // Top: sess-7 (10 compacts). Bottom of top-5: sess-3 (6 compacts).
  expect(findings[0]!.affectedItems[0]).toBe("sess-7");
  expect(findings[4]!.affectedItems[0]).toBe("sess-3");
});

test("ignores compacts outside the 14-day window", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      const oldIso = new Date(Date.now() - 20 * DAY).toISOString();
      for (let i = 0; i < 5; i++) {
        seedAutoCompact(db, {
          eventId: `old${i}`,
          timestamp: oldIso,
          sessionId: "old-session",
        });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("title encodes compact count and total pre-tokens", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let i = 0; i < 4; i++) {
        seedAutoCompact(db, {
          eventId: `e${i}`,
          timestamp: recentIso(i * HOUR),
          sessionId: "s1",
          preTokens: 150_000,
        });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.title).toContain("4×");
  expect(findings[0]!.title).toContain("600k"); // 4 × 150k = 600k pre-tokens
});
