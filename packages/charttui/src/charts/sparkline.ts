/**
 * Single-line sparkline using Unicode eighth-block characters.
 * 1 row tall; one cell per data point.
 */
import { type Cell, type Color, type Frame } from "../types.ts";
import { EIGHTHS } from "../internal/blocks.ts";

export type SparklineOptions = {
  color?: Color;
  /** Override min for scaling. */
  min?: number;
  /** Override max for scaling. */
  max?: number;
};

export function sparkline(values: number[], opts: SparklineOptions = {}): Frame {
  if (values.length === 0) return [[]];
  const min = opts.min ?? Math.min(...values);
  const max = opts.max ?? Math.max(...values);
  const range = max - min || 1;
  const color: Color = opts.color ?? "cyan";

  const row: Cell[] = values.map((v) => {
    const norm = Math.max(0, Math.min(1, (v - min) / range));
    const idx = Math.round(norm * (EIGHTHS.length - 1));
    const ch = EIGHTHS[idx] ?? " ";
    if (idx === 0) return { char: " " };
    return { char: ch, fg: color };
  });
  return [row];
}
