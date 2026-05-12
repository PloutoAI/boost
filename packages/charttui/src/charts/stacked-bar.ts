/**
 * Single-line stacked horizontal bar (proportional segments) + a legend
 * row underneath. Useful for share-of-total breakdowns.
 */
import { type Cell, type Color, type Frame } from "../types.ts";
import { allocateCells } from "../internal/cells.ts";

export type StackedBarSegment = {
  label: string;
  value: number;
  color: Color;
};

export type StackedBarOptions = {
  /** Total bar width in cells. Default 50. */
  width?: number;
  /** Show the legend row beneath the bar. Default true. */
  showLegend?: boolean;
  /** Block character for filled cells. Default `█`. */
  fill?: string;
};

const DEFAULT_OPTS: Required<StackedBarOptions> = {
  width: 50,
  showLegend: true,
  fill: "█",
};

export function stackedBar(segments: StackedBarSegment[], opts: StackedBarOptions = {}): Frame {
  const o = { ...DEFAULT_OPTS, ...opts };
  const cells = allocateCells(segments.map((s) => Math.max(0, s.value)), o.width);
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);

  const out: Frame = [];

  const barRow: Cell[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    for (let k = 0; k < (cells[i] ?? 0); k++) {
      barRow.push({ char: o.fill, fg: seg.color });
    }
  }
  out.push(barRow);

  if (o.showLegend) {
    const legend: Cell[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const pct = total === 0 ? 0 : Math.round((seg.value / total) * 100);
      legend.push({ char: "■", fg: seg.color });
      legend.push({ char: " " });
      const text = `${seg.label} ${pct}%`;
      for (const ch of text) legend.push({ char: ch });
      if (i < segments.length - 1) {
        legend.push({ char: " " });
        legend.push({ char: " " });
        legend.push({ char: " " });
      }
    }
    out.push(legend);
  }

  return out;
}
