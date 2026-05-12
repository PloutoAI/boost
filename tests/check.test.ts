import { test, expect } from "bun:test";
import { buildCheck } from "../src/output/check.ts";
import type { Finding } from "../src/types.ts";
import type { Summary } from "../src/summary.ts";

const HAS_DATA: Summary = {
  uncached_tokens_last_7_days: 1_000_000,
  cache_read_tokens_last_7_days: 0,
  input_tokens_last_7_days: 0,
  output_tokens_last_7_days: 0,
  cache_creation_tokens_last_7_days: 0,
  cache_hit_rate_last_7_days: 0,
  sessions_last_7_days: 3,
  total_predicted_savings_pct: 0,
  cost_last_7_days_usd: null,
  uncached_cost_last_7_days_usd: null,
  rate_limit_pressure: { level: "low", score: 10, drivers: [] },
};

const NO_DATA: Summary = {
  ...HAS_DATA,
  uncached_tokens_last_7_days: 0,
  cache_read_tokens_last_7_days: 0,
  sessions_last_7_days: 0,
};

function mkFinding(severity: Finding["severity"]): Finding {
  return {
    strategyId: "test",
    strategyVersion: 1,
    category: "trade-offs",
    severity,
    safeToApply: false,
    title: `dummy ${severity}`,
    affectedItems: [],
    estimatedTokensSavedPerRequest: 0,
    estimatedPercentOfWeeklyUsage: null,
    evidence: { observedAtIso: "2026-01-01T00:00:00.000Z", windowDays: 7, signals: {}, humanReadable: "" },
  };
}

test("returns exit code 3 when there is no Claude Code data yet", () => {
  const r = buildCheck([], NO_DATA);
  expect(r.exitCode).toBe(3);
  expect(r.text).toContain("no Claude Code data");
});

test("returns exit code 0 with the good-shape message when there are no findings", () => {
  const r = buildCheck([], HAS_DATA);
  expect(r.exitCode).toBe(0);
  expect(r.text).toContain("good shape");
});

test("exits 1 on a medium finding", () => {
  const r = buildCheck([mkFinding("medium")], HAS_DATA);
  expect(r.exitCode).toBe(1);
});

test("exits 1 on a high finding", () => {
  const r = buildCheck([mkFinding("high")], HAS_DATA);
  expect(r.exitCode).toBe(1);
});

test("exits 0 on only low findings", () => {
  const r = buildCheck([mkFinding("low"), mkFinding("low")], HAS_DATA);
  expect(r.exitCode).toBe(0);
});

test("output includes a severity histogram line", () => {
  const r = buildCheck(
    [mkFinding("high"), mkFinding("medium"), mkFinding("medium"), mkFinding("low")],
    HAS_DATA,
  );
  expect(r.text).toContain("1 high · 2 medium · 1 low");
  expect(r.counts).toEqual({ high: 1, medium: 2, low: 1 });
});
