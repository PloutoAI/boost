import { test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import strategy from "../../src/strategies/no-skills-advisory.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";
import {
  makeDetectorContext,
  fakeSkill,
  seedApiRequest,
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

test("returns null during cold start (< 7 days of data)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 3,
    skills: [],
    seed: (db) => {
      for (let i = 0; i < 10; i++) {
        seedApiRequest(db, { eventId: `e${i}`, timestamp: yesterdayIso(), sessionId: `s${i}` });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when any skill is installed", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    skills: [fakeSkill({ name: "a", path: path.join(h.claudeHome, "skills", "a") })],
    seed: (db) => {
      for (let i = 0; i < 10; i++) {
        seedApiRequest(db, { eventId: `e${i}`, timestamp: yesterdayIso(), sessionId: `s${i}` });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when activity is below the 5-session floor", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    skills: [],
    seed: (db) => {
      // Only 3 sessions — below threshold.
      for (let i = 0; i < 3; i++) {
        seedApiRequest(db, { eventId: `e${i}`, timestamp: yesterdayIso(), sessionId: `s${i}` });
      }
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("flags when active user has zero skills installed", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    skills: [],
    seed: (db) => {
      for (let i = 0; i < 7; i++) {
        seedApiRequest(db, { eventId: `e${i}`, timestamp: yesterdayIso(), sessionId: `s${i}` });
      }
    },
  });
  const result = strategy.detect(f.ctx);
  expect(result).not.toBeNull();
  const finding = Array.isArray(result) ? result[0]! : result!;
  expect(finding.severity).toBe("low");
  expect(finding.fixes).toBeUndefined(); // advisory only
  expect(finding.affectedItems).toEqual([]);
  expect(finding.title.toLowerCase()).toContain("reskill");
  const sig = finding.evidence.signals as { skillsInstalled: number; sessionsLast7Days: number };
  expect(sig.skillsInstalled).toBe(0);
  expect(sig.sessionsLast7Days).toBe(7);
});

test("explain text mentions `boost reskill` (the action to take)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    skills: [],
    seed: (db) => {
      for (let i = 0; i < 7; i++) {
        seedApiRequest(db, { eventId: `e${i}`, timestamp: yesterdayIso(), sessionId: `s${i}` });
      }
    },
  });
  const result = strategy.detect(f.ctx);
  const finding = Array.isArray(result) ? result![0]! : result!;
  const text = strategy.explain(finding);
  expect(text).toContain("boost reskill");
});
