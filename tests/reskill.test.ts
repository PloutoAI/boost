import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { buildReskillReport, createSkillDraft } from "../src/reskill.ts";
import { makeTempHome, type TempLoopHome } from "./helpers/temp-loop-home.ts";
import { makeDetectorContext, seedApiRequest } from "./helpers/detector-context.ts";

let h: TempLoopHome;
beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => h.cleanup());

const yesterdayIso = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

test("reskill recommends a project skill for repeated project activity", () => {
  const fake = makeDetectorContext({
    seed: (db) => {
      for (let i = 0; i < 8; i++) {
        seedApiRequest(db, {
          eventId: `req-${i}`,
          sessionId: `s-${i % 2}`,
          timestamp: yesterdayIso(),
          inputTokens: 1000,
          outputTokens: 500,
        });
      }
    },
  });
  const report = buildReskillReport(fake.ctx);
  expect(report.opportunities.some((op) => op.kind === "project-skill")).toBeTrue();
  fake.cleanup();
});

test("reskill creates a local skill draft", () => {
  const fake = makeDetectorContext();
  const draft = createSkillDraft("backend-project", fake.ctx);
  expect(draft.existed).toBeFalse();
  expect(fs.existsSync(draft.path)).toBeTrue();
  expect(fs.readFileSync(draft.path, "utf8")).toContain("name: backend-project");
  fake.cleanup();
});
