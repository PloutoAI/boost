import { test, expect } from "bun:test";
import { dollarsFor, formatUsd, pricingFor, PRICING_SNAPSHOT_DATE } from "../src/pricing.ts";

test("pricingFor returns prices for a known model id", () => {
  const opus = pricingFor("claude-opus-4-7");
  expect(opus).not.toBeNull();
  expect(opus!.input).toBeGreaterThan(0);
  expect(opus!.output).toBeGreaterThan(opus!.input); // output > input
  expect(opus!.cache_read).toBeLessThan(opus!.input); // cache reads cheaper than fresh input
});

test("pricingFor matches dated model suffixes via substring", () => {
  // `claude-haiku-4-5-20251001` is the real id; pricing entry is `claude-haiku-4-5`.
  const haiku = pricingFor("claude-haiku-4-5-20251001");
  expect(haiku).not.toBeNull();
  expect(haiku!.input).toBeGreaterThan(0);
});

test("pricingFor is case-insensitive", () => {
  expect(pricingFor("CLAUDE-OPUS-4-7")).not.toBeNull();
});

test("pricingFor returns null for unknown models (never silently 0)", () => {
  expect(pricingFor("gpt-4-turbo")).toBeNull();
  expect(pricingFor("<synthetic>")).toBeNull();
  expect(pricingFor("")).toBeNull();
  expect(pricingFor(null)).toBeNull();
  expect(pricingFor(undefined)).toBeNull();
});

test("dollarsFor computes correct cost for a small breakdown", () => {
  // 1M input + 1M output + 1M cache_creation + 10M cache_read on opus 4.7
  // = 15 + 75 + 18.75 + 15 = $123.75
  const cost = dollarsFor(
    { input: 1_000_000, output: 1_000_000, cache_creation: 1_000_000, cache_read: 10_000_000 },
    "claude-opus-4-7",
  );
  expect(cost).not.toBeNull();
  expect(cost!).toBeCloseTo(15 + 75 + 18.75 + 15, 2);
});

test("dollarsFor returns null for unknown models", () => {
  expect(
    dollarsFor({ input: 1_000_000, output: 1_000_000, cache_creation: 0, cache_read: 0 }, "<synthetic>"),
  ).toBeNull();
});

test("formatUsd renders in human-friendly bands", () => {
  expect(formatUsd(null)).toBe("—");
  expect(formatUsd(0)).toBe("$0");
  expect(formatUsd(0.005)).toBe("<$0.01");
  expect(formatUsd(3.456)).toBe("$3.46");
  expect(formatUsd(47.8)).toBe("$47.8");
  expect(formatUsd(1850)).toBe("$1850");
  expect(formatUsd(12_345)).toBe("$12.3k");
});

test("formatUsd handles negatives (for delta presentations)", () => {
  expect(formatUsd(-3.45)).toBe("-$3.45");
  expect(formatUsd(-200)).toBe("-$200");
});

test("snapshot date is exposed and well-formed", () => {
  expect(PRICING_SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
