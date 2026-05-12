#!/usr/bin/env bun
/**
 * Sixel pie chart demo.
 *
 *   1. Draw a real anti-aliased pie chart on a 2D canvas (`@napi-rs/canvas`).
 *   2. Read back the pixel buffer as RGBA.
 *   3. Encode to SIXEL escape sequences (`sixel` npm package).
 *   4. Print to stdout.
 *
 * Capable terminals (iTerm2 ≥ 3.3, WezTerm, foot, Konsole 22.04+, xterm
 * with -ti vt340) display it as a real PNG-quality image. Other terminals
 * (Apple Terminal, Alacritty, Windows Terminal, GNOME Terminal) print
 * garbage characters because they don't decode SIXEL.
 *
 * Run:
 *   bun packages/charttui/examples/sixel-pie.ts
 *
 * To check whether your terminal supports sixel, look for the SIXEL row
 * in the "Device Attributes" reply: send `\x1b[c`, parse the response;
 * if it contains `;4` in the parameter list it advertises sixel support.
 * (We don't probe in this demo — just emit and let the terminal handle it.)
 */
import { createCanvas } from "@napi-rs/canvas";
import { image2sixel } from "sixel";

// ──── Pie data ──────────────────────────────────────────────────────────────
type Segment = { label: string; value: number; color: string };
const segments: Segment[] = [
  { label: "Opus", value: 67, color: "#3DDBD9" },
  { label: "Sonnet", value: 22, color: "#F8C471" },
  { label: "Haiku", value: 11, color: "#D462E3" },
];

// ──── Render to canvas ──────────────────────────────────────────────────────
const SIZE = 320; // pixels — high enough for a smooth circle, small enough to scroll fit
const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext("2d");

// Background — pick something that contrasts in both light + dark terminals.
ctx.fillStyle = "#0d1117";
ctx.fillRect(0, 0, SIZE, SIZE);

// Pie geometry.
const cx = SIZE / 2;
const cy = SIZE / 2;
const radius = SIZE * 0.42;
const total = segments.reduce((s, x) => s + x.value, 0);

let startAngle = -Math.PI / 2; // 12 o'clock
for (const seg of segments) {
  const span = (seg.value / total) * Math.PI * 2;
  const endAngle = startAngle + span;

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, radius, startAngle, endAngle);
  ctx.closePath();
  ctx.fillStyle = seg.color;
  ctx.fill();

  // Slice border for crisper boundaries.
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#0d1117";
  ctx.stroke();

  startAngle = endAngle;
}

// Optional: draw the donut hole.
// ctx.globalCompositeOperation = "destination-out";
// ctx.beginPath();
// ctx.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
// ctx.fill();

// ──── Encode to SIXEL ───────────────────────────────────────────────────────
// `image2sixel` quantizes the RGBA buffer to a 256-color palette and emits
// the full DCS sequence (introducer + payload + ST). 256 colors is plenty
// for a pie with a handful of distinct segments.
const imageData = ctx.getImageData(0, 0, SIZE, SIZE);
const pixels = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
const sixel = image2sixel(pixels, SIZE, SIZE, 256);

// ──── Print ─────────────────────────────────────────────────────────────────
process.stdout.write("\n");
process.stdout.write(sixel);
process.stdout.write("\n\n");

// Legend (plain ANSI for context).
const ansi = (hex: string) => {
  // 24-bit truecolor; iTerm2/WezTerm support it.
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
};
const RESET = "\x1b[0m";
for (const seg of segments) {
  const pct = Math.round((seg.value / total) * 100);
  process.stdout.write(`  ${ansi(seg.color)}■${RESET} ${seg.label} — ${pct}%\n`);
}
process.stdout.write("\n");
