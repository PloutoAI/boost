/**
 * Sixel encoder wrapper. Sixel is a parallel image protocol to kitty —
 * same RGBA pixel data, different terminal transport.
 *
 * Supported terminals: iTerm2 ≥ 3.3, WezTerm, foot, Konsole 22.04+,
 * mintty, mlterm, xterm with `-ti vt340`, VS Code (with
 * `terminal.integrated.enableImages`).
 *
 * Uses the `sixel` npm package (jerch/node-sixel) — pure JS encoder
 * with optional native acceleration.
 */
import { image2sixel } from "sixel";

export type SixelImage = {
  rgba: Uint8Array;
  width: number;
  height: number;
  /** Color quantization budget. 256 is the sixel max; safe default. */
  maxColors?: number;
};

/**
 * Encode an RGBA buffer as a sixel escape sequence (DCS introducer +
 * payload + ST). Output is ready to write to stdout — the receiving
 * terminal renders it inline at the cursor position, advancing the
 * cursor by however many cells the image occupies.
 */
export function encodeSixel(img: SixelImage): string {
  return image2sixel(img.rgba, img.width, img.height, img.maxColors ?? 256);
}

/**
 * Detect sixel support via env vars (cheap, synchronous).
 * Returns true when the current terminal almost certainly speaks sixel.
 *
 * Coverage:
 *   iTerm.app (≥ 3.3, but we don't probe the version), WezTerm, ghostty
 *   does NOT support sixel, foot, Konsole 22.04+, mintty (via $TERM
 *   `mintty`), mlterm.
 */
export function detectSixelSupport(env: NodeJS.ProcessEnv = process.env): boolean {
  const program = env["TERM_PROGRAM"];
  const term = env["TERM"];
  if (program === "iTerm.app") return true;
  if (program === "WezTerm") return true;
  if (program === "vscode") return true; // works when enableImages is on
  if (env["KONSOLE_VERSION"]) return true;
  if (term === "mintty" || term === "mlterm") return true;
  if (term === "foot" || term?.startsWith("foot-")) return true;
  if (term?.includes("xterm") && env["XTERM_VERSION"]) {
    // xterm needs `-ti vt340` to enable sixel; we can't tell from env alone.
    // Be optimistic for now.
    return true;
  }
  return false;
}
