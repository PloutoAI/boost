/**
 * Vertical bar chart for time-series — single-color bars with axis +
 * tick labels. Each row uses Unicode eighth-block characters so a
 * 6-row chart can render ~48 distinct heights.
 */
import { type Cell, type Color, type Frame, EMPTY_CELL } from "../types.ts";
import { EIGHTHS } from "../internal/blocks.ts";
import { padEnd } from "../internal/cells.ts";

export type VerticalBarPoint = {
  label: string;
  value: number;
  /** Optional per-bar override color. */
  color?: Color;
};

export type VerticalBarOptions = {
  /** Chart body height in rows (excluding header + axis + ticks). Default 6. */
  height?: number;
  /** Cells per column (default 4 → 3 bar + 1 gap). */
  columnWidth?: number;
  /** Bar fill color. Default `cyan`. */
  barColor?: Color;
  /** Override max for scaling. Default = max value. */
  max?: number;
  /** Custom max-value formatter for the peak label. */
  formatPeak?: (n: number) => string;
  /** Show a "peak: <max>" header line. Default true. */
  showPeak?: boolean;
  /** Show the horizontal axis line under the bars. Default true. */
  showAxis?: boolean;
  /** Show tick labels under each column. Default true. */
  showTicks?: boolean;
};

const DEFAULT_OPTS: Required<Omit<VerticalBarOptions, "max" | "formatPeak">> = {
  height: 6,
  columnWidth: 4,
  barColor: "cyan",
  showPeak: true,
  showAxis: true,
  showTicks: true,
};

export function verticalBar(points: VerticalBarPoint[], opts: VerticalBarOptions = {}): Frame {
  const o = { ...DEFAULT_OPTS, ...opts };
  const formatPeak = opts.formatPeak ?? defaultFormat;
  const barWidth = Math.max(1, o.columnWidth - 1);
  const gap = o.columnWidth - barWidth;
  const max = opts.max ?? Math.max(1, ...points.map((p) => p.value));
  const totalLevels = o.height * 8;

  const quantized = points.map((p) =>
    max === 0 ? 0 : Math.max(0, Math.min(totalLevels, Math.round((p.value / max) * totalLevels))),
  );

  const out: Frame = [];

  if (o.showPeak) {
    const peak = `peak ${formatPeak(max)}`;
    const row: Cell[] = [...peak].map((ch) => ({ char: ch, dim: true }));
    out.push(row);
  }

  for (let r = 0; r < o.height; r++) {
    const rowMin = (o.height - r - 1) * 8;
    const row: Cell[] = [];
    for (let i = 0; i < quantized.length; i++) {
      const q = quantized[i]!;
      const within = Math.max(0, Math.min(8, q - rowMin));
      const ch = EIGHTHS[within] ?? " ";
      const color = points[i]!.color ?? (o.barColor as Color);
      for (let k = 0; k < barWidth; k++) {
        row.push(within === 0 ? EMPTY_CELL : { char: ch, fg: color });
      }
      if (i < quantized.length - 1) for (let k = 0; k < gap; k++) row.push(EMPTY_CELL);
    }
    out.push(row);
  }

  if (o.showAxis) {
    const axisWidth = points.length * o.columnWidth - gap;
    const row: Cell[] = [];
    for (let i = 0; i < axisWidth; i++) row.push({ char: "─", dim: true });
    out.push(row);
  }

  if (o.showTicks) {
    const row: Cell[] = [];
    for (let i = 0; i < points.length; i++) {
      const tick = padEnd(points[i]!.label.slice(0, barWidth), barWidth);
      for (const ch of tick) row.push({ char: ch, dim: true });
      if (i < points.length - 1) for (let k = 0; k < gap; k++) row.push(EMPTY_CELL);
    }
    out.push(row);
  }

  return out;
}

function defaultFormat(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return Math.round(n).toString();
}
