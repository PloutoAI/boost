/**
 * Render a Frame to an ANSI-styled string. Adjacent cells with the same
 * styling are coalesced into a single escape group to keep output compact.
 */
import { type Cell, type Color, type Frame } from "../types.ts";
import { fgCode, bgCode, RESET, BOLD, DIM } from "../internal/color.ts";

export type AnsiOptions = {
  /** Disable color output (useful for `NO_COLOR` / piped tests). */
  noColor?: boolean;
};

export function frameToAnsi(frame: Frame, opts: AnsiOptions = {}): string {
  const lines: string[] = [];
  for (const row of frame) {
    lines.push(rowToAnsi(row, opts));
  }
  return lines.join("\n");
}

function rowToAnsi(row: Cell[], opts: AnsiOptions): string {
  if (opts.noColor) return row.map((c) => c.char).join("");
  let out = "";
  let active: Cell | null = null;
  for (const c of row) {
    if (!sameStyle(active, c)) {
      if (active) out += RESET;
      out += stylePrefix(c);
      active = c;
    }
    out += c.char;
  }
  if (active) out += RESET;
  return out;
}

function sameStyle(a: Cell | null, b: Cell): boolean {
  if (!a) return !b.fg && !b.bg && !b.bold && !b.dim;
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim;
}

function stylePrefix(c: Cell): string {
  const codes: number[] = [];
  if (c.bold) codes.push(1);
  if (c.dim) codes.push(2);
  if (c.fg) codes.push(fgCode(c.fg as Color));
  if (c.bg) codes.push(bgCode(c.bg as Color));
  if (codes.length === 0) return "";
  return `\x1b[${codes.join(";")}m`;
}

void BOLD;
void DIM;
