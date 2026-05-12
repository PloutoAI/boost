#!/usr/bin/env bun
/**
 * charttui showcase — renders every chart type to ANSI and prints to stdout.
 *
 * Run:
 *   bun packages/charttui/examples/showcase.ts
 *
 * Or, from the repo root:
 *   bun run charttui:demo
 */
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
  type Frame,
} from "../src/index.ts";

const ESC = "\x1b[";
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;

function header(title: string): void {
  console.log("");
  console.log(`${BOLD}━━━ ${title} ${"━".repeat(Math.max(0, 60 - title.length))}${RESET}`);
  console.log("");
}

function show(title: string, frame: Frame): void {
  console.log(`${DIM}${title}${RESET}`);
  console.log(frameToAnsi(frame));
  console.log("");
}

console.log(`${BOLD}charttui · showcase${RESET}`);
console.log(`${DIM}Run with NO_COLOR=1 to disable color, or pipe through cat to see raw ANSI codes.${RESET}`);

// ─── Horizontal bar ─────────────────────────────────────────────────────────
header("HorizontalBar");
show(
  "Top tools (last 7 days)",
  horizontalBar(
    [
      { label: "Bash", value: 700, valueLabel: "calls" },
      { label: "Edit", value: 580, valueLabel: "calls" },
      { label: "Read", value: 396, valueLabel: "calls" },
      { label: "Write", value: 197, valueLabel: "calls" },
      { label: "TaskUpdate", value: 80, valueLabel: "calls" },
    ],
    { width: 70, barColor: "cyan" },
  ),
);
show(
  "Mixed colors per row",
  horizontalBar(
    [
      { label: "production", value: 100, color: "red" },
      { label: "staging", value: 70, color: "yellow" },
      { label: "preview", value: 40, color: "green" },
      { label: "dev", value: 20, color: "blue" },
    ],
    { width: 70 },
  ),
);

// ─── Vertical bar ───────────────────────────────────────────────────────────
header("VerticalBar");
show(
  "Daily uncached tokens",
  verticalBar(
    [
      { label: "04-29", value: 750_000 },
      { label: "04-30", value: 2_840_000 },
      { label: "05-01", value: 4_330_000 },
      { label: "05-02", value: 4_310_000 },
      { label: "05-03", value: 3_400_000 },
      { label: "05-05", value: 2_560_000 },
      { label: "05-06", value: 940_000 },
    ],
    { height: 6, columnWidth: 7, barColor: "green" },
  ),
);

// ─── Stacked bar ────────────────────────────────────────────────────────────
header("StackedBar");
show(
  "Model mix",
  stackedBar(
    [
      { label: "Opus", value: 19_000_000, color: "cyan" },
      { label: "Sonnet", value: 5_000_000, color: "yellow" },
      { label: "Haiku", value: 1_700_000, color: "magenta" },
    ],
    { width: 70 },
  ),
);

// ─── Progress bar ───────────────────────────────────────────────────────────
header("ProgressBar");
show("Test suite progress", progressBar(0.75, { width: 50, color: "green" }));
show(
  "Disk usage (warning)",
  progressBar(0.92, { width: 50, color: "red" }),
);
show(
  "Custom format",
  progressBar(0.42, {
    width: 50,
    color: "blue",
    formatLabel: (f) => `${(f * 100).toFixed(1)}% / 100GB`,
  }),
);

// ─── Pie ────────────────────────────────────────────────────────────────────
header("Pie");
show(
  "Three-segment pie",
  pie(
    [
      { label: "Opus", value: 67, color: "cyan" },
      { label: "Sonnet", value: 22, color: "yellow" },
      { label: "Haiku", value: 11, color: "magenta" },
    ],
    { radius: 10 },
  ),
);

show(
  "Two-segment pie (50/50)",
  pie(
    [
      { label: "production", value: 50, color: "red" },
      { label: "staging", value: 50, color: "blue" },
    ],
    { radius: 8 },
  ),
);

// ─── Donut ──────────────────────────────────────────────────────────────────
header("Donut");
show(
  "Four-segment donut",
  donut(
    [
      { label: "Bash", value: 40, color: "cyan" },
      { label: "Edit", value: 30, color: "magenta" },
      { label: "Read", value: 20, color: "yellow" },
      { label: "Write", value: 10, color: "green" },
    ],
    { radius: 10 },
  ),
);

// ─── Line chart ─────────────────────────────────────────────────────────────
header("LineChart");
show(
  "Two series — sine + cosine",
  lineChart(
    [
      {
        label: "sine",
        color: "cyan",
        values: Array.from({ length: 40 }, (_, i) => Math.sin(i * 0.3)),
      },
      {
        label: "cosine",
        color: "magenta",
        values: Array.from({ length: 40 }, (_, i) => Math.cos(i * 0.3)),
      },
    ],
    { height: 8, width: 60 },
  ),
);

show(
  "Single series — request counts per hour",
  lineChart(
    [
      {
        label: "requests",
        color: "green",
        values: [
          12, 8, 6, 4, 3, 5, 18, 42, 67, 89, 78, 65, 73, 82, 71, 64, 58, 49, 35, 22, 15, 11, 9, 7,
        ],
      },
    ],
    { height: 6, width: 60 },
  ),
);

// ─── Sparkline ──────────────────────────────────────────────────────────────
header("Sparkline");
show(
  "CPU usage (last 30 samples)",
  sparkline(
    Array.from({ length: 30 }, (_, i) => Math.sin(i * 0.4) * 50 + 50 + Math.random() * 10),
    { color: "yellow" },
  ),
);

show(
  "Daily commits — last 14 days",
  sparkline([3, 1, 0, 0, 5, 12, 8, 2, 0, 1, 4, 9, 14, 7], { color: "cyan" }),
);

console.log(
  `${DIM}done · all eight chart types rendered above${RESET}`,
);
console.log("");
