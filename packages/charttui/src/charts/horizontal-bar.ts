/**
 * Horizontal bar chart for top-N rankings.
 * Each row: label (left) · proportional bar · value (right).
 *
 * The bar uses 8-fraction precision via Unicode horizontal-eighth
 * characters, so a 20-column bar can express 160 distinct lengths.
 */
import { type Cell, type Color, type Frame, EMPTY_CELL } from "../types.ts";
import { HORIZONTAL_EIGHTHS } from "../internal/blocks.ts";
import { padEnd, padStart, trim } from "../internal/cells.ts";

export type HorizontalBarRow = {
  label: string;
  value: number;
  /** Optional per-row color. Defaults to `opts.barColor`. */
  color?: Color;
  /** Optional unit/suffix shown after the numeric value. */
  valueLabel?: string;
};

export type HorizontalBarOptions = {
  /** Total visible width (label + bar + value). Default 60. */
  width?: number;
  /** Width reserved for the label column. Default 24. */
  labelWidth?: number;
  /** Width reserved for the value column. Default 14. */
  valueWidth?: number;
  /** Default bar color when a row doesn't specify one. Default `cyan`. */
  barColor?: Color;
  /** Override max for proportional scaling. Default = max value across rows. */
  max?: number;
  /** Custom value formatter. Default: 1.2k / 3.4M / raw. */
  formatValue?: (n: number) => string;
};

const DEFAULT_OPTS: Required<Omit<HorizontalBarOptions, "max" | "formatValue">> = {
  width: 60,
  labelWidth: 24,
  valueWidth: 14,
  barColor: "cyan",
};

export function horizontalBar(rows: HorizontalBarRow[], opts: HorizontalBarOptions = {}): Frame {
  const o = { ...DEFAULT_OPTS, ...opts };
  const formatValue = opts.formatValue ?? defaultFormat;
  const barWidth = Math.max(2, o.width - o.labelWidth - o.valueWidth - 2);
  const max = opts.max ?? Math.max(1, ...rows.map((r) => r.value));

  const out: Frame = [];
  for (const r of rows) {
    const row: Cell[] = [];
    const label = padEnd(trim(r.label, o.labelWidth), o.labelWidth);
    for (const ch of label) row.push({ char: ch });
    row.push(EMPTY_CELL);

    const eighths = Math.max(0, Math.min(barWidth * 8, Math.round((r.value / max) * barWidth * 8)));
    const fullBlocks = Math.floor(eighths / 8);
    const remainderEighth = eighths % 8;
    const barColor: Color = r.color ?? (o.barColor as Color);
    for (let i = 0; i < fullBlocks; i++) row.push({ char: "█", fg: barColor });
    if (remainderEighth > 0) row.push({ char: HORIZONTAL_EIGHTHS[remainderEighth]!, fg: barColor });
    const drawn = fullBlocks + (remainderEighth > 0 ? 1 : 0);
    for (let i = drawn; i < barWidth; i++) row.push(EMPTY_CELL);
    row.push(EMPTY_CELL);

    const valueText = padStart(
      trim(formatValue(r.value) + (r.valueLabel ? ` ${r.valueLabel}` : ""), o.valueWidth),
      o.valueWidth,
    );
    for (const ch of valueText) row.push({ char: ch, dim: true });

    out.push(row);
  }
  return out;
}

function defaultFormat(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return Math.round(n).toString();
}
