import { test, expect } from "bun:test";
import type { Finding } from "../src/types.ts";
import { rankFindings } from "../src/ranker.ts";

function f(over: Partial<Finding>): Finding {
  return {
    strategyId: over.strategyId ?? "s",
    strategyVersion: 1,
    category: over.category ?? "clear-wins",
    severity: over.severity ?? "medium",
    safeToApply: true,
    title: "t",
    affectedItems: [],
    estimatedTokensSavedPerRequest: 0,
    estimatedPercentOfWeeklyUsage: over.estimatedPercentOfWeeklyUsage ?? null,
    evidence: { observedAtIso: "", windowDays: 0, signals: {}, humanReadable: "" },
    fixes: [{ kind: "modify-file", payload: { filePath: "", newContent: "" } }],
    ...over,
  } as Finding;
}

test("clear-wins precede trade-offs", () => {
  const ranked = rankFindings([
    f({ strategyId: "a", category: "trade-offs", severity: "high" }),
    f({ strategyId: "b", category: "clear-wins", severity: "low" }),
  ]);
  expect(ranked[0]?.strategyId).toBe("b");
});

test("within category, severity desc, then percent desc", () => {
  const ranked = rankFindings([
    f({ strategyId: "low5", severity: "low", estimatedPercentOfWeeklyUsage: 5 }),
    f({ strategyId: "highNull", severity: "high", estimatedPercentOfWeeklyUsage: null }),
    f({ strategyId: "high10", severity: "high", estimatedPercentOfWeeklyUsage: 10 }),
    f({ strategyId: "med8", severity: "medium", estimatedPercentOfWeeklyUsage: 8 }),
  ]);
  expect(ranked.map((r) => r.strategyId)).toEqual(["high10", "highNull", "med8", "low5"]);
});

test("empty input returns empty", () => {
  expect(rankFindings([])).toEqual([]);
});
