#!/usr/bin/env bun
/**
 * Native chart demo — pure-JS rasterizer + kitty graphics protocol.
 *
 * Renders a pie, donut, and line chart as actual pixel buffers and emits
 * kitty graphics escape sequences. Run in **kitty / ghostty / WezTerm /
 * Konsole** — those terminals will display real anti-aliased images.
 *
 * iTerm2, Apple Terminal, Alacritty, Windows Terminal, GNOME Terminal:
 * will print escape garbage. There is no fallback by design.
 *
 * Run:
 *   bun run charttui:native
 *
 * Override the support check (force-emit anyway):
 *   CHARTTUI_FORCE=1 bun run charttui:native
 */
import {
  pieCanvas,
  donutCanvas,
  lineChartCanvas,
  encodeImage,
  detectSupport,
} from "../src/native/index.ts";

const force = process.env["CHARTTUI_FORCE"] === "1";
const supported = detectSupport();

if (!supported && !force) {
  process.stderr.write(
    [
      "charttui native requires a kitty graphics protocol terminal:",
      "  kitty, ghostty, WezTerm, Konsole",
      "",
      "Detected: " +
        `TERM=${process.env["TERM"] ?? "(unset)"} ` +
        `TERM_PROGRAM=${process.env["TERM_PROGRAM"] ?? "(unset)"}`,
      "",
      "To force-emit anyway, set CHARTTUI_FORCE=1.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const segments = [
  { label: "Opus", value: 67, color: "#3DDBD9" },
  { label: "Sonnet", value: 22, color: "#F8C471" },
  { label: "Haiku", value: 11, color: "#D462E3" },
];

const out = process.stdout;

out.write("\n  Pie (anti-aliased, kitty graphics):\n");
const pie = pieCanvas(segments, { width: 320, height: 320 });
out.write(
  encodeImage(
    { rgba: pie.pixels, width: pie.width, height: pie.height, imageId: 1 },
    { cols: 24, rows: 12 },
  ),
);
out.write("\n");

for (const seg of segments) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  out.write(`  \x1b[38;2;${hexRgb(seg.color)}m■\x1b[0m ${seg.label} — ${Math.round((seg.value / total) * 100)}%\n`);
}

out.write("\n  Donut (innerRadius 0.55):\n");
const dn = donutCanvas(segments, { width: 320, height: 320 });
out.write(
  encodeImage(
    { rgba: dn.pixels, width: dn.width, height: dn.height, imageId: 2 },
    { cols: 24, rows: 12 },
  ),
);
out.write("\n");

out.write("\n  Line chart (two series, 60 samples):\n");
const lc = lineChartCanvas(
  [
    {
      label: "sine",
      color: "#3DDBD9",
      values: Array.from({ length: 60 }, (_, i) => Math.sin(i * 0.2)),
    },
    {
      label: "cosine",
      color: "#D462E3",
      values: Array.from({ length: 60 }, (_, i) => Math.cos(i * 0.2)),
    },
  ],
  { width: 720, height: 240, background: "#0d1117" },
);
out.write(
  encodeImage(
    { rgba: lc.pixels, width: lc.width, height: lc.height, imageId: 3 },
    { cols: 60, rows: 12 },
  ),
);
out.write("\n\n");

function hexRgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r};${g};${b}`;
}
