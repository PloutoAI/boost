import { test, expect, beforeEach, afterEach } from "bun:test";
import strategy from "../../src/strategies/retry-storm-advisory.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";
import {
  makeDetectorContext,
  seedApiError,
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

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

// Anchor every test's events ~1 day before real `Date.now()` so they
// fall inside the detector's 14-day window. Per-test offsets stay
// positive milliseconds from this anchor. Same convention as the other
// strategy tests (yesterdayIso() etc.).
const anchorMs = (): number => Date.now() - 1 * DAY;
const at = (offsetMs: number): string => new Date(anchorMs() + offsetMs).toISOString();

function asArray(r: Finding | Finding[] | null): Finding[] {
  if (r === null) return [];
  return Array.isArray(r) ? r : [r];
}

test("returns null during cold start (< 7 days of data)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 3,
    seed: (db) => {
      for (let i = 0; i < 5; i++) {
        seedApiError(db, {
          eventId: `e${i}`,
          timestamp: at(i * 5 * SECOND),
          sessionId: "s1",
          retryAttempt: i + 1,
        });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when no api_error events exist", () => {
  f = makeDetectorContext({ daysOfDataAvailable: 30 });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("ignores isolated errors that don't reach the storm threshold", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // Two errors only — below MIN_CLUSTER_SIZE of 3.
      seedApiError(db, { eventId: "e1", timestamp: at(0), sessionId: "s1" });
      seedApiError(db, { eventId: "e2", timestamp: at(5 * SECOND), sessionId: "s1", retryAttempt: 2 });
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("flags one storm in one session — returns a one-element array", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let i = 0; i < 4; i++) {
        seedApiError(db, {
          eventId: `e${i}`,
          timestamp: at(i * 10 * SECOND),
          sessionId: "s1",
          retryAttempt: i + 1,
          retryInMs: 1000,
        });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  const fnd = findings[0]!;
  expect(fnd.affectedItems).toEqual(["s1"]);
  expect(fnd.severity).toBe("low"); // single storm, < 60s wait, no cap hit
  expect(fnd.safeToApply).toBe(false);
  expect(fnd.fixes).toBeUndefined();
  const sig = fnd.evidence.signals as { storms: number; totalRetries: number; hitMaxRetries: boolean };
  expect(sig.storms).toBe(1);
  expect(sig.totalRetries).toBe(4);
  expect(sig.hitMaxRetries).toBe(false);
});

test("escalates to high severity when retry cap is hit", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // 3 retries, the third one hits max (attempt 3 of 3).
      seedApiError(db, { eventId: "e1", timestamp: at(0), sessionId: "s1", retryAttempt: 1, maxRetries: 3 });
      seedApiError(db, { eventId: "e2", timestamp: at(10 * SECOND), sessionId: "s1", retryAttempt: 2, maxRetries: 3 });
      seedApiError(db, { eventId: "e3", timestamp: at(20 * SECOND), sessionId: "s1", retryAttempt: 3, maxRetries: 3 });
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.severity).toBe("high");
  const sig = findings[0]!.evidence.signals as { hitMaxRetries: boolean; maxAttemptSeen: number };
  expect(sig.hitMaxRetries).toBe(true);
  expect(sig.maxAttemptSeen).toBe(3);
});

test("escalates to medium severity when total wait exceeds 60s", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // 3 retries, 25s wait each = 75s total, no cap.
      for (let i = 0; i < 3; i++) {
        seedApiError(db, {
          eventId: `e${i}`,
          timestamp: at(i * 30 * SECOND),
          sessionId: "s1",
          retryAttempt: i + 1,
          maxRetries: 10,
          retryInMs: 25_000,
        });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.severity).toBe("medium");
});

test("splits clusters when the gap between consecutive errors exceeds 60s", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // Cluster A: 3 retries packed together.
      for (let i = 0; i < 3; i++) {
        seedApiError(db, {
          eventId: `a${i}`,
          timestamp: at(i * 10 * SECOND),
          sessionId: "s1",
          retryAttempt: i + 1,
        });
      }
      // 5-minute gap.
      // Cluster B: 3 more retries.
      for (let i = 0; i < 3; i++) {
        seedApiError(db, {
          eventId: `b${i}`,
          timestamp: at(5 * MINUTE + i * 10 * SECOND),
          sessionId: "s1",
          retryAttempt: i + 1,
        });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  const sig = findings[0]!.evidence.signals as { storms: number; clusters: unknown[] };
  expect(sig.storms).toBe(2);
  expect(sig.clusters.length).toBe(2);
  // 2 storms < 3 and wait < 60s → still low.
  expect(findings[0]!.severity).toBe("low");
});

test("escalates to medium severity at 3+ storms in one session", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // 3 clusters of 3 retries each, separated by 5 min gaps.
      for (let cluster = 0; cluster < 3; cluster++) {
        for (let i = 0; i < 3; i++) {
          seedApiError(db, {
            eventId: `c${cluster}-${i}`,
            timestamp: at(cluster * 5 * MINUTE + i * 10 * SECOND),
            sessionId: "s1",
            retryAttempt: i + 1,
          });
        }
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.severity).toBe("medium");
  const sig = findings[0]!.evidence.signals as { storms: number };
  expect(sig.storms).toBe(3);
});

test("emits one finding per session and ranks by total retry wait", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // Session 'small': 3 retries, 500ms each = 1.5s total
      for (let i = 0; i < 3; i++) {
        seedApiError(db, {
          eventId: `sm${i}`,
          timestamp: at(i * 10 * SECOND),
          sessionId: "small",
          retryAttempt: i + 1,
          retryInMs: 500,
        });
      }
      // Session 'big': 3 retries, 10s each = 30s total — ranked first.
      for (let i = 0; i < 3; i++) {
        seedApiError(db, {
          eventId: `bg${i}`,
          timestamp: at(i * 10 * SECOND),
          sessionId: "big",
          retryAttempt: i + 1,
          retryInMs: 10_000,
        });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(2);
  expect(findings[0]!.affectedItems[0]).toBe("big");
  expect(findings[1]!.affectedItems[0]).toBe("small");
});

test("caps output to top 5 sessions even when more sessions storm", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let s = 0; s < 8; s++) {
        for (let i = 0; i < 3; i++) {
          seedApiError(db, {
            eventId: `s${s}-${i}`,
            timestamp: at(i * 10 * SECOND),
            sessionId: `sess-${s}`,
            retryAttempt: i + 1,
            // Stagger wait so ranking is deterministic.
            retryInMs: 1000 + s * 100,
          });
        }
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(5);
  // Top finding is sess-7 (highest retry wait), bottom is sess-3.
  expect(findings[0]!.affectedItems[0]).toBe("sess-7");
  expect(findings[4]!.affectedItems[0]).toBe("sess-3");
});

test("ignores errors outside the 14-day window", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // Old cluster — 20 days before now, outside the 14-day window.
      const oldBase = Date.now() - 20 * DAY;
      for (let i = 0; i < 5; i++) {
        seedApiError(db, {
          eventId: `old${i}`,
          timestamp: new Date(oldBase + i * 10 * SECOND).toISOString(),
          sessionId: "old-session",
          retryAttempt: i + 1,
          maxRetries: 10,
        });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("computes title from signals (storm count, cap-hit phrasing)", () => {
  // Build a finding via detect, then check title shape.
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let i = 0; i < 3; i++) {
        seedApiError(db, {
          eventId: `e${i}`,
          timestamp: at(i * 10 * SECOND),
          sessionId: "s1",
          retryAttempt: i + 1,
          maxRetries: 3,
        });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.title).toContain("retry cap");
  expect(findings[0]!.title).toContain("1 retry storm");
});
