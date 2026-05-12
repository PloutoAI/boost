/**
 * High-level native chart renderers — produce a `Canvas` (RGBA buffer)
 * that you can hand to a kitty-graphics encoder for terminal display.
 *
 * Each renderer is a pure function `(data, opts) => Canvas` so it can be
 * piped to ANY image protocol — kitty, sixel, iTerm2 inline, file output,
 * whatever. We don't bind to a specific protocol here.
 */
import {
  type Canvas,
  type RGBA,
  createCanvas,
  drawLine,
  drawPolyline,
  fillArc,
  fillCircle,
  fillRect,
  rgba,
  strokeCircle,
} from "./rasterizer.ts";

const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

// ─── Pie ────────────────────────────────────────────────────────────────────

export type NativePieSegment = {
  label: string;
  value: number;
  /** Hex color: `#RRGGBB`. */
  color: string;
};

export type NativePieOptions = {
  /** Canvas width in pixels. Default 400. */
  width?: number;
  /** Canvas height in pixels. Default 400. */
  height?: number;
  /** Outer radius as fraction of `min(width, height)/2`. Default 0.85. */
  radius?: number;
  /** Inner radius as fraction of outer (donut). 0 = solid pie. Default 0. */
  innerRadius?: number;
  /** Optional border between slices. Default `#0d1117` (dark). */
  borderColor?: string;
  /** Border thickness in pixels. Default 2. */
  borderWidth?: number;
  /** Background hex color. Default transparent. */
  background?: string | null;
};

export function pieCanvas(segments: NativePieSegment[], opts: NativePieOptions = {}): Canvas {
  const w = opts.width ?? 400;
  const h = opts.height ?? 400;
  const radius = ((opts.radius ?? 0.85) * Math.min(w, h)) / 2;
  const innerRadius = (opts.innerRadius ?? 0) * radius;
  const cx = w / 2;
  const cy = h / 2;
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;

  const bg: RGBA = opts.background === null || opts.background === undefined
    ? TRANSPARENT
    : rgba(opts.background);
  const canvas = createCanvas(w, h, bg);

  let startAngle = 0;
  for (const seg of segments) {
    const span = (Math.max(0, seg.value) / total) * Math.PI * 2;
    if (span > 0) {
      fillArc(canvas, cx, cy, radius, innerRadius, startAngle, startAngle + span, rgba(seg.color));
    }
    startAngle += span;
  }

  // Slice borders for crisper segmentation. Skip if explicitly disabled
  // (borderWidth: 0).
  const borderWidth = opts.borderWidth ?? 2;
  if (borderWidth > 0) {
    const borderColor = rgba(opts.borderColor ?? "#0d1117");
    let a = 0;
    for (const seg of segments) {
      const span = (Math.max(0, seg.value) / total) * Math.PI * 2;
      if (span > 0) {
        const x = cx + Math.sin(a) * radius;
        const y = cy - Math.cos(a) * radius;
        const xi = cx + Math.sin(a) * innerRadius;
        const yi = cy - Math.cos(a) * innerRadius;
        drawLine(canvas, xi, yi, x, y, borderColor, borderWidth);
      }
      a += span;
    }
    // Outer rim & inner rim outline.
    strokeCircle(canvas, cx, cy, radius, borderColor, borderWidth);
    if (innerRadius > 0) strokeCircle(canvas, cx, cy, innerRadius, borderColor, borderWidth);
  }

  return canvas;
}

// ─── Line chart ─────────────────────────────────────────────────────────────

export type NativeLineSeries = {
  label: string;
  values: number[];
  /** Hex color. */
  color: string;
  /** Line thickness in pixels. Default 2. */
  thickness?: number;
};

export type NativeLineChartOptions = {
  width?: number;
  height?: number;
  /** Pixel padding around the plot region for axes / labels. */
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
  background?: string | null;
  axisColor?: string;
  /** Override Y range. Defaults to data min/max. */
  min?: number;
  max?: number;
};

export function lineChartCanvas(series: NativeLineSeries[], opts: NativeLineChartOptions = {}): Canvas {
  const w = opts.width ?? 600;
  const h = opts.height ?? 240;
  const pad = {
    top: opts.padding?.top ?? 12,
    right: opts.padding?.right ?? 12,
    bottom: opts.padding?.bottom ?? 12,
    left: opts.padding?.left ?? 12,
  };
  const plotX = pad.left;
  const plotY = pad.top;
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const bg: RGBA = opts.background === null ? TRANSPARENT : rgba(opts.background ?? "#0d1117");
  const canvas = createCanvas(w, h, bg);

  if (series.length === 0) return canvas;

  const all = series.flatMap((s) => s.values);
  const min = opts.min ?? Math.min(...all);
  const max = opts.max ?? Math.max(...all);
  const range = max - min || 1;
  const longest = Math.max(...series.map((s) => s.values.length));

  // Frame.
  const axisColor = rgba(opts.axisColor ?? "#444c56");
  fillRect(canvas, plotX, plotY + plotH, plotW, 1, axisColor); // baseline
  fillRect(canvas, plotX, plotY, 1, plotH, axisColor); // left axis

  for (const s of series) {
    if (s.values.length === 0) continue;
    const xStep = s.values.length === 1 ? 0 : plotW / (s.values.length - 1);
    const points: [number, number][] = s.values.map((v, i) => {
      const norm = (v - min) / range;
      return [plotX + i * xStep, plotY + (1 - norm) * plotH];
    });
    drawPolyline(canvas, points, rgba(s.color), s.thickness ?? 2);
    // Highlight last point.
    const last = points[points.length - 1]!;
    fillCircle(canvas, last[0], last[1], 2.5, rgba(s.color));
  }

  void longest;
  return canvas;
}

// ─── Donut convenience ──────────────────────────────────────────────────────

export function donutCanvas(segments: NativePieSegment[], opts: NativePieOptions = {}): Canvas {
  return pieCanvas(segments, { ...opts, innerRadius: opts.innerRadius ?? 0.55 });
}
