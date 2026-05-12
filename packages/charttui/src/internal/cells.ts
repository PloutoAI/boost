/**
 * Largest-remainder cell allocation. Given an array of values that should
 * occupy a fixed total width, return integer cell counts per value summing
 * to exactly `width`. Distributes rounding error to the entries with the
 * largest fractional parts so the visual proportions stay accurate.
 */
export function allocateCells(values: number[], width: number): number[] {
  if (width <= 0 || values.length === 0) return values.map(() => 0);
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return values.map(() => 0);

  const exact = values.map((v) => (Math.max(0, v) / total) * width);
  const floors = exact.map((e) => Math.floor(e));
  let remainder = width - floors.reduce((s, x) => s + x, 0);
  const fracs = exact.map((e, i) => ({ i, frac: e - Math.floor(e) }));
  fracs.sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < fracs.length && remainder > 0; k++) {
    floors[fracs[k]!.i] = (floors[fracs[k]!.i] ?? 0) + 1;
    remainder--;
  }
  return floors;
}

/** Trim a string to `max` chars, appending `…` if it had to be cut. */
export function trim(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max === 1) return "…";
  return s.slice(0, max - 1) + "…";
}

/** Pad-end ASCII (visual width assumed = string length). */
export function padEnd(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

export function padStart(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : " ".repeat(width - s.length) + s;
}
