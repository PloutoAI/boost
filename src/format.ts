/**
 * Number / string formatters shared across every output surface (JSON
 * drivers, plain text, TUI). One source of truth — when the format
 * tweaks (separators, decimal counts, locale rules), it tweaks once.
 */

/**
 * Compact human-readable count: `1_234_567` → `1.2M`, `5_400` → `5k`,
 * `42` → `42`. Inputs may be fractional; the result is always an integer
 * (or one-decimal millions) so the same value always renders identically
 * regardless of which surface called it.
 */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k`;
  return `${sign}${Math.round(abs)}`;
}

/**
 * Truncate `s` to at most `max` characters, replacing the last character
 * with an ellipsis when shortened. Strings already within budget are
 * returned unchanged.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Keep the last two path segments of an absolute path. Used as a compact
 * label in tables and chart legends — full paths overflow most layouts
 * while a single segment loses the disambiguating parent (e.g.
 * `loop/packages/charttui` vs `velo/packages/charttui`).
 */
export function shortPath(p: string): string {
  const segs = p.split("/").filter((s) => s.length > 0);
  return segs.slice(-2).join("/") || p;
}
