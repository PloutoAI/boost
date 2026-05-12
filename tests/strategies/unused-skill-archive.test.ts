import { test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import strategy from "../../src/strategies/unused-skill-archive.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";
import {
  makeDetectorContext,
  fakeSkill,
  seedApiRequest,
  seedSkillActivated,
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

const DAY = 24 * 60 * 60 * 1000;
const yesterdayIso = () => new Date(Date.now() - DAY).toISOString();

test("returns null in cold start (< 14 days of data)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 5,
    skills: [fakeSkill({ name: "demo", path: path.join(h.claudeHome, "skills", "demo") })],
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when no skills installed", () => {
  f = makeDetectorContext({ daysOfDataAvailable: 30, skills: [] });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when no skill_activated events exist (no real signal)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    skills: [
      fakeSkill({ name: "a", path: path.join(h.claudeHome, "skills", "a") }),
      fakeSkill({ name: "b", path: path.join(h.claudeHome, "skills", "b") }),
      fakeSkill({ name: "c", path: path.join(h.claudeHome, "skills", "c") }),
      fakeSkill({ name: "d", path: path.join(h.claudeHome, "skills", "d") }),
      fakeSkill({ name: "e", path: path.join(h.claudeHome, "skills", "e") }),
    ],
    seed: (db) => seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() }),
  });
  // Without any skill_activated events the detector deliberately stays silent.
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("flags skills not activated in the window when signal is present", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    skills: [
      fakeSkill({ name: "active", path: path.join(h.claudeHome, "skills", "active") }),
      fakeSkill({ name: "inactive", path: path.join(h.claudeHome, "skills", "inactive") }),
    ],
    seed: (db) => {
      seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() });
      seedSkillActivated(db, { eventId: "sk1", timestamp: yesterdayIso(), skillName: "active" });
    },
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.affectedItems).toEqual(["inactive"]);
  expect(finding.fixes!.length).toBe(1);
  expect(finding.fixes![0].kind).toBe("archive-directory");
});

test("respects 14-day install grace period", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    skills: [
      // Installed 3 days ago — should be skipped despite no activation.
      fakeSkill({ name: "fresh", path: path.join(h.claudeHome, "skills", "fresh"), daysOld: 3 }),
    ],
    seed: (db) => {
      seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() });
      seedSkillActivated(db, { eventId: "sk1", timestamp: yesterdayIso(), skillName: "other" });
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null if every installed skill activated in the window", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    skills: [fakeSkill({ name: "a", path: path.join(h.claudeHome, "skills", "a") })],
    seed: (db) => {
      seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() });
      seedSkillActivated(db, { eventId: "sk1", timestamp: yesterdayIso(), skillName: "a" });
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});
