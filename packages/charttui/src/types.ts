/**
 * Core types for charttui. Each chart returns a `Frame` — a 2D grid of
 * styled cells. Rendering adapters (ANSI strings, React) consume Frames.
 *
 * A Frame is rectangular: every row has the same width. Cells with no
 * content use `EMPTY_CELL` (a single space, no styling).
 */

/** Standard 16-color terminal colors plus extended named colors. */
export type Color =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

export type Cell = {
  /** Single visible character. Use `' '` for blank cells. */
  char: string;
  fg?: Color;
  bg?: Color;
  /** Bold modifier — useful for axis labels and titles. */
  bold?: boolean;
  /** Dim modifier — useful for axis lines and secondary text. */
  dim?: boolean;
};

/** Rectangular grid of styled cells. `frame[y][x]` for row y, column x. */
export type Frame = Cell[][];

export const EMPTY_CELL: Cell = { char: " " };

/** Build a blank frame of the given dimensions. */
export function blankFrame(width: number, height: number): Frame {
  const out: Frame = [];
  for (let y = 0; y < height; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < width; x++) row.push({ char: " " });
    out.push(row);
  }
  return out;
}

/** Pad a frame to the given width by appending blank cells; truncate if wider. */
export function padFrameWidth(frame: Frame, width: number): Frame {
  return frame.map((row) => {
    if (row.length === width) return row;
    if (row.length > width) return row.slice(0, width);
    return [...row, ...Array.from({ length: width - row.length }, () => ({ char: " " }) as Cell)];
  });
}

/** Stack frames vertically. All frames are padded to the maximum width. */
export function vstack(...frames: Frame[]): Frame {
  if (frames.length === 0) return [];
  const width = Math.max(...frames.map((f) => (f[0]?.length ?? 0)));
  const out: Frame = [];
  for (const f of frames) for (const row of padFrameWidth(f, width)) out.push(row);
  return out;
}

/** Common shared options for charts that have a width budget. */
export type WidthSpec = number;

/** Common shared options for charts that have a height budget. */
export type HeightSpec = number;
