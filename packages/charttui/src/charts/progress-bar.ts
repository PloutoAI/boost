/**
 * Single-line progress bar with optional percentage label.
 *
 * Layout (default):
 *   [████████████████████░░░░░░░░░░░░] 62%
 *
 * Uses Unicode horizontal-eighth characters for sub-cell precision so a
 * 30-cell bar can express 240 distinct fill amounts.
 */
import { type Cell, type Color, type Frame } from "../types.ts";
import { HORIZONTAL_EIGHTHS } from "../internal/blocks.ts";

export type ProgressBarOptions = {
  /** Total bar width including brackets and label. Default 40. */
  width?: number;
  /** Bar color. Default `green`. */
  color?: Color;
  /** Color for the empty/remaining portion. Default dim gray. */
  emptyColor?: Color;
  /** Whether to draw `[ ]` brackets around the bar. Default true. */
  brackets?: boolean;
  /** Whether to show "NN%" suffix. Default true. */
  showLabel?: boolean;
  /** Character for the empty portion. Default `░`. */
  emptyChar?: string;
  /** Custom label formatter. Receives a 0..1 fraction. */
  formatLabel?: (frac: number) => string;
};

const DEFAULT_OPTS: Required<Omit<ProgressBarOptions, "formatLabel" | "emptyColor">> = {
  width: 40,
  color: "green",
  brackets: true,
  showLabel: true,
  emptyChar: "░",
};

/**
 * `value` is a 0..1 fraction. Values outside that range are clamped.
 */
export function progressBar(value: number, opts: ProgressBarOptions = {}): Frame {
  const o = { ...DEFAULT_OPTS, ...opts };
  const formatLabel = opts.formatLabel ?? ((f) => `${Math.round(f * 100)}%`);
  const frac = Math.max(0, Math.min(1, value));

  const labelText = o.showLabel ? ` ${formatLabel(frac)}` : "";
  const bracketCells = o.brackets ? 2 : 0;
  const barWidth = Math.max(2, o.width - bracketCells - labelText.length);

  const eighths = Math.max(0, Math.min(barWidth * 8, Math.round(frac * barWidth * 8)));
  const fullBlocks = Math.floor(eighths / 8);
  const remainder = eighths % 8;

  const row: Cell[] = [];
  if (o.brackets) row.push({ char: "[" });
  for (let i = 0; i < fullBlocks; i++) row.push({ char: "█", fg: o.color });
  if (remainder > 0) row.push({ char: HORIZONTAL_EIGHTHS[remainder]!, fg: o.color });
  const drawn = fullBlocks + (remainder > 0 ? 1 : 0);
  for (let i = drawn; i < barWidth; i++)
    row.push({ char: o.emptyChar, fg: opts.emptyColor ?? "gray", dim: true });
  if (o.brackets) row.push({ char: "]" });
  if (o.showLabel) for (const ch of labelText) row.push({ char: ch });

  return [row];
}
