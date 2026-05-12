/**
 * ASCII line chart for one or more series. Draws connected line segments
 * between adjacent data points using Braille characters for sub-cell
 * precision (each cell maps to a 2×4 dot grid, so a 60×10 chart can
 * express 120×40 effective resolution).
 */
import { type Cell, type Color, type Frame } from "../types.ts";

export type LineSeries = {
  label: string;
  values: number[];
  color: Color;
};

export type LineChartOptions = {
  /** Chart body height in rows. Default 8. */
  height?: number;
  /** Chart body width in cells. Default = max series length × 3 (capped at 80). */
  width?: number;
  /** Show min/max axis labels on the left. Default true. */
  showAxis?: boolean;
  /** Override min for scaling. Default = min across all series. */
  min?: number;
  /** Override max for scaling. Default = max across all series. */
  max?: number;
  /** Custom value formatter for axis labels. */
  formatValue?: (n: number) => string;
};

const DEFAULT_OPTS: Required<Omit<LineChartOptions, "width" | "min" | "max" | "formatValue">> = {
  height: 8,
  showAxis: true,
};

// Braille dot indices:
//   1 4
//   2 5
//   3 6
//   7 8
const DOT_BITS = [
  [0x01, 0x08], // y=0: top-left, top-right
  [0x02, 0x10], // y=1
  [0x04, 0x20], // y=2
  [0x40, 0x80], // y=3 (bottom)
];

export function lineChart(series: LineSeries[], opts: LineChartOptions = {}): Frame {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (series.length === 0) return [];

  const formatValue = opts.formatValue ?? defaultFormat;
  const allValues = series.flatMap((s) => s.values);
  const min = opts.min ?? Math.min(...allValues);
  const max = opts.max ?? Math.max(...allValues);
  const range = max - min || 1;

  const longest = Math.max(...series.map((s) => s.values.length));
  const widthCells = opts.width ?? Math.min(80, Math.max(20, longest * 3));
  const dotCols = widthCells * 2;
  const dotRows = o.height * 4;

  // For each series, walk pairs of points and rasterize a line in dot space.
  // Per-cell color = color of the series whose dot is in that cell. If
  // multiple series share a cell, the LAST one drawn wins (deterministic
  // by series order).
  type DotCell = { mask: number; color: Color };
  const grid: (DotCell | null)[][] = Array.from({ length: o.height }, () =>
    Array.from({ length: widthCells }, () => null),
  );

  for (const s of series) {
    const xs = s.values;
    if (xs.length === 0) continue;
    const xScale = xs.length === 1 ? 0 : (dotCols - 1) / (xs.length - 1);

    const points = xs.map((v, i) => {
      const dotX = Math.round(i * xScale);
      const norm = (v - min) / range;
      const dotY = Math.round((1 - norm) * (dotRows - 1));
      return { x: dotX, y: dotY };
    });

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      drawLine(grid, a.x, a.y, b.x, b.y, s.color);
    }
    // Always plot the last point so a single-point series renders.
    if (points.length === 1) {
      const p = points[0]!;
      plotDot(grid, p.x, p.y, s.color);
    }
  }

  // Render axis labels if requested.
  const axisWidth = o.showAxis ? Math.max(formatValue(max).length, formatValue(min).length) + 1 : 0;

  const out: Frame = [];
  for (let row = 0; row < o.height; row++) {
    const cells: Cell[] = [];
    if (o.showAxis) {
      const label =
        row === 0
          ? formatValue(max)
          : row === o.height - 1
            ? formatValue(min)
            : "";
      const padded = label.padStart(axisWidth - 1) + "│";
      for (const ch of padded) cells.push({ char: ch, dim: true });
    }
    for (let col = 0; col < widthCells; col++) {
      const cell = grid[row]?.[col];
      if (!cell || cell.mask === 0) {
        cells.push({ char: " " });
      } else {
        cells.push({ char: brailleChar(cell.mask), fg: cell.color });
      }
    }
    out.push(cells);
  }

  return out;
}

function plotDot(
  grid: ({ mask: number; color: Color } | null)[][],
  dotX: number,
  dotY: number,
  color: Color,
): void {
  const cellY = Math.floor(dotY / 4);
  const cellX = Math.floor(dotX / 2);
  const subY = dotY % 4;
  const subX = dotX % 2;
  const row = grid[cellY];
  if (!row) return;
  const existing = row[cellX] ?? { mask: 0, color };
  row[cellX] = { mask: existing.mask | (DOT_BITS[subY]?.[subX] ?? 0), color };
}

/** Bresenham line in dot space; plots dots into the cell grid. */
function drawLine(
  grid: ({ mask: number; color: Color } | null)[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: Color,
): void {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    plotDot(grid, x, y, color);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function brailleChar(mask: number): string {
  return String.fromCharCode(0x2800 + mask);
}

function defaultFormat(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return Math.round(n).toString();
}
