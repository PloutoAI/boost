/**
 * Block-character constants used by bar/sparkline/pie renderers.
 *
 * `EIGHTHS` are the eighth-block characters from empty (0) → full (8).
 * Each row of a vertical bar can express 8 sub-cell heights via these.
 *
 * `HORIZONTAL_EIGHTHS` are the eighth-block characters that grow
 * left-to-right for horizontal bar precision.
 */
export const EIGHTHS: readonly string[] = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export const HORIZONTAL_EIGHTHS: readonly string[] = [
  " ",
  "▏",
  "▎",
  "▍",
  "▌",
  "▋",
  "▊",
  "▉",
  "█",
];

export const FULL_BLOCK = "█";
export const UPPER_HALF = "▀";
export const LOWER_HALF = "▄";
export const LIGHT_SHADE = "░";
export const MEDIUM_SHADE = "▒";
export const DARK_SHADE = "▓";

export const BOX_HORIZONTAL = "─";
export const BOX_VERTICAL = "│";
