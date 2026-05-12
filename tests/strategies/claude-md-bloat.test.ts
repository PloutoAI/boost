import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import strategy from "../../src/strategies/claude-md-bloat.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";
import {
  makeDetectorContext,
  fakeClaudeMd,
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

test("returns null when no global CLAUDE.md exists", () => {
  f = makeDetectorContext({
    claudeMdFiles: [
      // Only project-level files.
      fakeClaudeMd({ path: path.join(h.claudeHome, "..", "project", ".claude", "CLAUDE.md"), wordCount: 5000 }),
    ],
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when global CLAUDE.md is under threshold", () => {
  const globalPath = path.join(h.claudeHome, "CLAUDE.md");
  f = makeDetectorContext({
    claudeMdFiles: [fakeClaudeMd({ path: globalPath, wordCount: 1000 })],
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("flags global CLAUDE.md when over threshold", () => {
  const globalPath = path.join(h.claudeHome, "CLAUDE.md");
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    claudeMdFiles: [fakeClaudeMd({ path: globalPath, wordCount: 5000 })],
    seed: (db) => seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() }),
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.severity).toBe("high"); // 5000 > 4000 threshold
  expect(finding.safeToApply).toBe(false); // advisory-only
  expect(finding.fixes!.length).toBe(1);
  expect(finding.fixes![0].kind).toBe("modify-file");
  expect(finding.affectedItems).toEqual([fs.realpathSync(globalPath)]);
});

test("severity scales with word count", () => {
  const globalPath = path.join(h.claudeHome, "CLAUDE.md");
  let i = 0;
  for (const [words, expectedSeverity] of [
    [1700, "low"],
    [3000, "medium"],
    [4500, "high"],
  ] as const) {
    if (f) f.cleanup();
    const idx = i++;
    f = makeDetectorContext({
      daysOfDataAvailable: 30,
      claudeMdFiles: [fakeClaudeMd({ path: globalPath, wordCount: words })],
      seed: (db) =>
        seedApiRequest(db, { eventId: `e${idx}`, timestamp: yesterdayIso() }),
    });
    const finding = singleFinding(strategy.detect(f.ctx));
    expect(finding.severity).toBe(expectedSeverity);
  }
});

test("does NOT flag project-level CLAUDE.md (only global)", () => {
  const globalPath = path.join(h.claudeHome, "CLAUDE.md");
  const projectPath = path.join(h.claudeHome, "..", "myproject", ".claude", "CLAUDE.md");
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    claudeMdFiles: [
      fakeClaudeMd({ path: globalPath, wordCount: 1000 }), // under threshold
      fakeClaudeMd({ path: projectPath, wordCount: 6000 }), // over, but project-level
    ],
    seed: (db) => seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() }),
  });
  // Global is under threshold → null.
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when global file was edited recently (within 14 days)", () => {
  const globalPath = path.join(h.claudeHome, "CLAUDE.md");
  fs.writeFileSync(globalPath, "x".repeat(5000 * 5));
  // Default mtime is "now", which is within 14 days.
  const file = {
    path: globalPath,
    content: "x".repeat(5000 * 5),
    wordCount: 5000,
    estimatedTokens: 6650,
    imports: [],
  };
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    claudeMdFiles: [file],
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

function yesterdayIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}
