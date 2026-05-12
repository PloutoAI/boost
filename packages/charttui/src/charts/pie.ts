/**
 * Pie / donut chart, rendered with **quadrant block characters** for
 * solid (not dotted) circular fills.
 *
 * Each text cell is split into 2×2 sub-pixels — TL, TR, BL, BR. There are
 * 16 quadrant glyphs (` ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█`) mapping any subset to a single
 * solid character. Boundary cells where two segments meet use fg/bg —
 * fg paints the dominant-color quadrants, bg paints the secondary's.
 * Cells at the outer edge of the disk leave bg unset (terminal default
 * shows through as the panel background), so the circle's edge is clean.
 *
 * Why this is better than Braille for pies:
 *   - Braille dots have visible gaps inside filled regions. Quadrants are
 *     solid — a fully-inside cell renders as `█`, not a dot pattern.
 *   - Quadrants give 2×2 sub-pixel detail at every cell. Combined with
 *     fg/bg painting at segment boundaries, edges are clean and continuous.
 *
 * Aspect: terminal cells are ~2:1 (height:width), so the pie is `2r × r`
 * cells — twice as wide as tall in cell count, which is square in screen
 * pixels.
 */
import { type Cell, type Color, type Frame } from "../types.ts";

export type PieSegment = {
  label: string;
  value: number;
  color: Color;
};

export type PieOptions = {
  /** Pie outer radius in *text rows*. Default 10 (20×10 cells). */
  radius?: number;
  /** Donut inner-radius as a 0..1 fraction of `radius`. Default 0 (filled pie). */
  innerRadius?: number;
  /** Show a legend below the pie. Default true. */
  showLegend?: boolean;
};

const DEFAULT_OPTS: Required<Omit<PieOptions, "innerRadius">> = {
  radius: 10,
  showLegend: true,
};

/**
 * Quadrant glyphs by 4-bit mask (TL=8, TR=4, BL=2, BR=1).
 * All 16 entries are solid block characters — no gaps.
 */
const QUADRANT_CHARS: ReadonlyArray<string> = [
  " ", // 0000 empty
  "▗", // 0001 BR
  "▖", // 0010 BL
  "▄", // 0011 BL+BR
  "▝", // 0100 TR
  "▐", // 0101 TR+BR (right half)
  "▞", // 0110 TR+BL (NE-SW diagonal)
  "▟", // 0111 TR+BL+BR
  "▘", // 1000 TL
  "▚", // 1001 TL+BR (NW-SE diagonal)
  "▌", // 1010 TL+BL (left half)
  "▙", // 1011 TL+BL+BR
  "▀", // 1100 TL+TR (top half)
  "▜", // 1101 TL+TR+BR
  "▛", // 1110 TL+TR+BL
  "█", // 1111 all
];

export function pie(segments: PieSegment[], opts: PieOptions = {}): Frame {
  const o = { ...DEFAULT_OPTS, ...opts };
  const innerRadius = Math.max(0, Math.min(0.95, opts.innerRadius ?? 0));
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);

  type Arc = { color: Color; from: number; to: number };
  const arcs: Arc[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const v = Math.max(0, seg.value);
    const span = total === 0 ? 0 : (v / total) * Math.PI * 2;
    if (span > 0) arcs.push({ color: seg.color, from: cursor, to: cursor + span });
    cursor += span;
  }
  const segmentAt = (angle: number): Color | undefined => {
    if (arcs.length === 0) return undefined;
    for (const a of arcs) if (angle >= a.from && angle < a.to) return a.color;
    return arcs[arcs.length - 1]!.color;
  };

  const r = Math.max(3, o.radius);
  const cellsWide = r * 2;
  const cellsTall = r;
  // Sub-pixel grid: 2 horizontal × 2 vertical per cell.
  const subWide = cellsWide * 2;
  const subTall = cellsTall * 2;

  // Disk lives inside [-1, 1] × [-1, 1]. Sub-pixel grid is square in screen
  // pixels because cell aspect is 2:1.
  const cx = (subWide - 1) / 2;
  const cy = (subTall - 1) / 2;
  const halfWide = subWide / 2;
  const halfTall = subTall / 2;

  // Sample one sub-pixel: returns the segment color, or undefined for
  // pixels outside the disk / inside the donut hole.
  const sampleSub = (px: number, py: number): Color | undefined => {
    const dx = (px - cx) / halfWide;
    const dy = (py - cy) / halfTall;
    const r2 = dx * dx + dy * dy;
    if (r2 > 1 || r2 < innerRadius * innerRadius) return undefined;
    let angle = Math.atan2(dx, -dy);
    if (angle < 0) angle += Math.PI * 2;
    return segmentAt(angle);
  };

  const out: Frame = [];
  for (let cellY = 0; cellY < cellsTall; cellY++) {
    const row: Cell[] = [];
    for (let cellX = 0; cellX < cellsWide; cellX++) {
      const tl = sampleSub(cellX * 2, cellY * 2);
      const tr = sampleSub(cellX * 2 + 1, cellY * 2);
      const bl = sampleSub(cellX * 2, cellY * 2 + 1);
      const br = sampleSub(cellX * 2 + 1, cellY * 2 + 1);
      row.push(quadrantCell(tl, tr, bl, br));
    }
    out.push(row);
  }

  if (o.showLegend) {
    out.push([]); // spacer
    for (const seg of segments) {
      const pct = total === 0 ? 0 : Math.round((Math.max(0, seg.value) / total) * 100);
      const row: Cell[] = [
        { char: "■", fg: seg.color },
        { char: " " },
      ];
      const text = `${seg.label} — ${pct}%`;
      for (const ch of text) row.push({ char: ch });
      out.push(row);
    }
  }

  return out;
}

/** Donut chart — pie with a hole. */
export function donut(segments: PieSegment[], opts: PieOptions = {}): Frame {
  return pie(segments, { ...opts, innerRadius: opts.innerRadius ?? 0.55 });
}

/**
 * Compose four sub-pixel colors into a single quadrant cell.
 *
 * Cases:
 *   - All four undefined → blank cell.
 *   - All non-undefined sub-pixels share one color → solid mono cell with
 *     that color and a quadrant char masked to the inside-disk sub-pixels.
 *   - Two distinct colors present → primary (more cells) goes to fg, the
 *     other to bg, quadrant char masks the primary's positions.
 */
function quadrantCell(
  tl: Color | undefined,
  tr: Color | undefined,
  bl: Color | undefined,
  br: Color | undefined,
): Cell {
  const subs: ReadonlyArray<Color | undefined> = [tl, tr, bl, br];
  if (subs.every((s) => s === undefined)) return { char: " " };

  // Count colors; pick primary = most common.
  const counts = new Map<Color, number>();
  for (const s of subs) {
    if (s !== undefined) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const primary = sorted[0]![0];
  const secondary = sorted[1]?.[0];

  // Bit mask for primary positions: TL=8, TR=4, BL=2, BR=1.
  let mask = 0;
  if (tl === primary) mask |= 8;
  if (tr === primary) mask |= 4;
  if (bl === primary) mask |= 2;
  if (br === primary) mask |= 1;

  const char = QUADRANT_CHARS[mask] ?? "█";
  // Only set bg when there's a *different* paint color in the cell. If
  // the non-primary sub-pixels are `undefined` (outside the disk), leave
  // bg unset so the panel background shows through cleanly.
  const result: Cell = { char, fg: primary };
  if (secondary !== undefined) result.bg = secondary;
  return result;
}
