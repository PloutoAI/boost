import { test, expect, beforeEach, afterEach } from "bun:test";
import strategy from "../../src/strategies/subagent-cost-advisory.ts";
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

function asArray(r: Finding | Finding[] | null): Finding[] {
  if (r === null) return [];
  return Array.isArray(r) ? r : [r];
}

test("returns null during cold start (< 7 days of data)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 3,
    seed: (db) => {
      seedApiRequest(db, {
        eventId: "e1",
        timestamp: yesterdayIso(),
        sessionId: "s1",
        inputTokens: 50_000,
        outputTokens: 50_000,
        isSidechain: true,
      });
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when no api_request events exist", () => {
  f = makeDetectorContext({ daysOfDataAvailable: 30 });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when no sidechain spend exists", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let i = 0; i < 5; i++) {
        seedApiRequest(db, {
          eventId: `e${i}`,
          timestamp: yesterdayIso(),
          sessionId: "s1",
          inputTokens: 50_000,
          outputTokens: 50_000,
          isSidechain: false,
        });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when session is below the 100k uncached floor", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // 50k total — under the floor.
      seedApiRequest(db, {
        eventId: "main",
        timestamp: yesterdayIso(),
        sessionId: "tiny",
        inputTokens: 10_000,
        outputTokens: 10_000,
        isSidechain: false,
      });
      seedApiRequest(db, {
        eventId: "sub",
        timestamp: yesterdayIso(),
        sessionId: "tiny",
        inputTokens: 15_000,
        outputTokens: 15_000,
        isSidechain: true,
      });
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when sidechain share is under the 15% threshold", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // Main spend: 900k tokens
      for (let i = 0; i < 9; i++) {
        seedApiRequest(db, {
          eventId: `m${i}`,
          timestamp: yesterdayIso(),
          sessionId: "s1",
          inputTokens: 50_000,
          outputTokens: 50_000,
          isSidechain: false,
        });
      }
      // Sidechain: 100k = 10% of total — below threshold.
      seedApiRequest(db, {
        eventId: "sub1",
        timestamp: yesterdayIso(),
        sessionId: "s1",
        inputTokens: 50_000,
        outputTokens: 50_000,
        isSidechain: true,
      });
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("flags a session where sidechain is ~40% of uncached → medium severity", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // Main: 6 × 100k = 600k
      for (let i = 0; i < 6; i++) {
        seedApiRequest(db, {
          eventId: `m${i}`,
          timestamp: yesterdayIso(),
          sessionId: "s1",
          inputTokens: 50_000,
          outputTokens: 50_000,
          isSidechain: false,
        });
      }
      // Sub: 4 × 100k = 400k → 400k/1M = 40%
      for (let i = 0; i < 4; i++) {
        seedApiRequest(db, {
          eventId: `s${i}`,
          timestamp: yesterdayIso(),
          sessionId: "s1",
          inputTokens: 50_000,
          outputTokens: 50_000,
          isSidechain: true,
        });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.affectedItems).toEqual(["s1"]);
  expect(findings[0]!.severity).toBe("medium");
  expect(findings[0]!.safeToApply).toBe(false);
  expect(findings[0]!.fixes).toBeUndefined();
  const sig = findings[0]!.evidence.signals as {
    sharePct: number;
    sidechainTokens: number;
    totalTokens: number;
    sidechainRequests: number;
    totalRequests: number;
  };
  expect(sig.sharePct).toBeCloseTo(40, 0);
  expect(sig.sidechainTokens).toBe(400_000);
  expect(sig.totalTokens).toBe(1_000_000);
  expect(sig.sidechainRequests).toBe(4);
  expect(sig.totalRequests).toBe(10);
});

test("escalates to high severity at ≥ 60% sidechain share", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // Main: 200k
      seedApiRequest(db, {
        eventId: "m1",
        timestamp: yesterdayIso(),
        sessionId: "s1",
        inputTokens: 100_000,
        outputTokens: 100_000,
        isSidechain: false,
      });
      // Sub: 800k → 80% share
      seedApiRequest(db, {
        eventId: "s1",
        timestamp: yesterdayIso(),
        sessionId: "s1",
        inputTokens: 400_000,
        outputTokens: 400_000,
        isSidechain: true,
      });
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.severity).toBe("high");
});

test("uses low severity at 15-30% share", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // Main: 800k
      for (let i = 0; i < 8; i++) {
        seedApiRequest(db, {
          eventId: `m${i}`,
          timestamp: yesterdayIso(),
          sessionId: "s1",
          inputTokens: 50_000,
          outputTokens: 50_000,
          isSidechain: false,
        });
      }
      // Sub: 200k → 20%
      for (let i = 0; i < 2; i++) {
        seedApiRequest(db, {
          eventId: `s${i}`,
          timestamp: yesterdayIso(),
          sessionId: "s1",
          inputTokens: 50_000,
          outputTokens: 50_000,
          isSidechain: true,
        });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  expect(findings[0]!.severity).toBe("low");
});

test("emits one finding per session and ranks by absolute sidechain spend", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      // Session 'big': 500k sidechain out of 1M total
      seedApiRequest(db, {
        eventId: "big-m",
        timestamp: yesterdayIso(),
        sessionId: "big",
        inputTokens: 250_000,
        outputTokens: 250_000,
        isSidechain: false,
      });
      seedApiRequest(db, {
        eventId: "big-s",
        timestamp: yesterdayIso(),
        sessionId: "big",
        inputTokens: 250_000,
        outputTokens: 250_000,
        isSidechain: true,
      });
      // Session 'small': 100k sidechain out of 200k total (50% share — higher share, smaller absolute)
      seedApiRequest(db, {
        eventId: "small-m",
        timestamp: yesterdayIso(),
        sessionId: "small",
        inputTokens: 50_000,
        outputTokens: 50_000,
        isSidechain: false,
      });
      seedApiRequest(db, {
        eventId: "small-s",
        timestamp: yesterdayIso(),
        sessionId: "small",
        inputTokens: 50_000,
        outputTokens: 50_000,
        isSidechain: true,
      });
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(2);
  // 'big' ranked first because absolute sidechain tokens are higher.
  expect(findings[0]!.affectedItems[0]).toBe("big");
  expect(findings[1]!.affectedItems[0]).toBe("small");
});

test("caps output to top 5 sessions when more sessions qualify", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      for (let i = 0; i < 8; i++) {
        // Each session: 100k main + (i+1)*50k sidechain — share well above 15% for all.
        seedApiRequest(db, {
          eventId: `m${i}`,
          timestamp: yesterdayIso(),
          sessionId: `sess-${i}`,
          inputTokens: 50_000,
          outputTokens: 50_000,
          isSidechain: false,
        });
        seedApiRequest(db, {
          eventId: `s${i}`,
          timestamp: yesterdayIso(),
          sessionId: `sess-${i}`,
          inputTokens: (i + 1) * 25_000,
          outputTokens: (i + 1) * 25_000,
          isSidechain: true,
        });
      }
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(5);
  // Top is sess-7 (highest absolute sidechain), bottom is sess-3.
  expect(findings[0]!.affectedItems[0]).toBe("sess-7");
  expect(findings[4]!.affectedItems[0]).toBe("sess-3");
});

test("ignores api_request rows outside the 14-day window", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      const oldIso = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 10; i++) {
        seedApiRequest(db, {
          eventId: `old${i}`,
          timestamp: oldIso,
          sessionId: "old-session",
          inputTokens: 50_000,
          outputTokens: 50_000,
          isSidechain: i % 2 === 0,
        });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("title encodes share% and absolute subagent tokens", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    seed: (db) => {
      seedApiRequest(db, {
        eventId: "m1",
        timestamp: yesterdayIso(),
        sessionId: "s1",
        inputTokens: 200_000,
        outputTokens: 200_000,
        isSidechain: false,
      });
      seedApiRequest(db, {
        eventId: "s1",
        timestamp: yesterdayIso(),
        sessionId: "s1",
        inputTokens: 300_000,
        outputTokens: 300_000,
        isSidechain: true,
      });
    },
  });
  const findings = asArray(strategy.detect(f.ctx));
  expect(findings.length).toBe(1);
  // 600k sidechain / 1M total = 60% → high
  expect(findings[0]!.severity).toBe("high");
  expect(findings[0]!.title).toContain("60%");
  expect(findings[0]!.title.toLowerCase()).toContain("subagent");
});
