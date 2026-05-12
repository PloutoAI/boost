import { test, expect } from "bun:test";
import {
  horizontalBar,
  verticalBar,
  stackedBar,
  progressBar,
  pie,
  donut,
  lineChart,
  sparkline,
  frameToAnsi,
} from "../src/index.ts";

test("horizontalBar produces a row per input row", () => {
  const f = horizontalBar(
    [
      { label: "a", value: 100 },
      { label: "b", value: 50 },
    ],
    { width: 30 },
  );
  expect(f.length).toBe(2);
  expect(f[0]!.length).toBeGreaterThan(0);
});

test("horizontalBar bar lengths are proportional to value", () => {
  const f = horizontalBar(
    [
      { label: "big", value: 100 },
      { label: "small", value: 25 },
    ],
    { width: 40, labelWidth: 8, valueWidth: 8 },
  );
  // Count `█` cells per row in the bar region.
  const fullCount = (row: typeof f[0]) => row.filter((c) => c.char === "█").length;
  const big = fullCount(f[0]!);
  const small = fullCount(f[1]!);
  expect(big).toBeGreaterThan(small);
  // ~4× ratio — within 1 cell of strict proportion (eighth precision).
  expect(big / Math.max(1, small)).toBeGreaterThanOrEqual(3);
});

test("verticalBar height matches `height` + axis + ticks + peak", () => {
  const f = verticalBar(
    [
      { label: "a", value: 5 },
      { label: "b", value: 10 },
    ],
    { height: 4, showPeak: true, showAxis: true, showTicks: true },
  );
  expect(f.length).toBe(4 + 1 + 1 + 1); // body + peak + axis + ticks
});

test("stackedBar with two equal segments produces a half-and-half row", () => {
  const f = stackedBar(
    [
      { label: "a", value: 1, color: "cyan" },
      { label: "b", value: 1, color: "magenta" },
    ],
    { width: 20, showLegend: false },
  );
  expect(f.length).toBe(1);
  expect(f[0]!.length).toBe(20);
  const cyan = f[0]!.filter((c) => c.fg === "cyan").length;
  const magenta = f[0]!.filter((c) => c.fg === "magenta").length;
  expect(cyan).toBe(10);
  expect(magenta).toBe(10);
});

test("progressBar renders a single row", () => {
  const f = progressBar(0.5, { width: 30 });
  expect(f.length).toBe(1);
  expect(f[0]!.length).toBeGreaterThan(0);
});

test("progressBar at 0 is empty; at 1 is fully filled", () => {
  const empty = progressBar(0, { width: 20, showLabel: false, brackets: false });
  expect(empty[0]!.every((c) => c.char === "░" || c.char === " ")).toBeTrue();
  const full = progressBar(1, { width: 20, showLabel: false, brackets: false });
  expect(full[0]!.filter((c) => c.char === "█").length).toBeGreaterThanOrEqual(18);
});

test("pie produces an approximately circular block of cells", () => {
  const f = pie(
    [
      { label: "a", value: 50, color: "cyan" },
      { label: "b", value: 50, color: "magenta" },
    ],
    { radius: 8, showLegend: false },
  );
  // r text rows tall × 2r cells wide.
  expect(f.length).toBe(8);
  expect(f[0]!.length).toBe(16);
  // Center row should contain colored cells.
  expect(f[4]!.some((c) => c.fg === "cyan" || c.fg === "magenta")).toBeTrue();
});

test("donut leaves a hole in the center", () => {
  const f = donut(
    [
      { label: "a", value: 50, color: "cyan" },
      { label: "b", value: 50, color: "magenta" },
    ],
    { radius: 12, innerRadius: 0.6, showLegend: false },
  );
  // Grab a row near the middle and check the central quadrants are blank.
  const mid = f[6]!;
  const center = mid.slice(10, 14);
  expect(center.every((c) => c.char === " ")).toBeTrue();
});

test("lineChart renders a connected line", () => {
  const f = lineChart(
    [
      { label: "demo", values: [1, 5, 3, 7, 2, 6], color: "cyan" },
    ],
    { height: 6, width: 30, showAxis: false },
  );
  expect(f.length).toBe(6);
  // At least some braille cells present.
  expect(f.flat().some((c) => c.char.charCodeAt(0) >= 0x2800 && c.char.charCodeAt(0) < 0x2900)).toBeTrue();
});

test("sparkline produces a single row of N cells", () => {
  const f = sparkline([1, 2, 3, 4, 5, 4, 3, 2, 1]);
  expect(f.length).toBe(1);
  expect(f[0]!.length).toBe(9);
});

test("frameToAnsi includes color codes and resets", () => {
  const f = horizontalBar([{ label: "x", value: 10 }], { width: 20 });
  const s = frameToAnsi(f);
  expect(s).toContain("\x1b[");
  expect(s).toContain("\x1b[0m");
});

test("frameToAnsi with noColor strips escapes", () => {
  const f = horizontalBar([{ label: "x", value: 10 }], { width: 20 });
  const s = frameToAnsi(f, { noColor: true });
  expect(s).not.toContain("\x1b[");
});
