/**
 * Image-protocol selector. We rasterize once, encode for whichever
 * graphics protocol the current terminal supports.
 *
 *   detectProtocol() → "kitty" | "sixel" | null
 *
 * `null` means the terminal doesn't support any image protocol we know
 * how to emit. There is intentionally no text-mode fallback here.
 */
import { type Canvas } from "./rasterizer.ts";
import { detectSupport as detectKittySupport, encodeImage as encodeKitty } from "./kitty.ts";
import { detectSixelSupport, encodeSixel } from "./sixel.ts";

export type Protocol = "kitty" | "sixel";

export function detectProtocol(env: NodeJS.ProcessEnv = process.env): Protocol | null {
  // kitty graphics is preferred when available — better color depth,
  // alpha channel, and chunked transmission.
  if (detectKittySupport(env)) return "kitty";
  if (detectSixelSupport(env)) return "sixel";
  return null;
}

export type RenderOptions = {
  /** Force a specific protocol regardless of detection. */
  protocol?: Protocol;
  /** Image ID for kitty placement. Only used when protocol = kitty. */
  imageId?: number;
  /** Render width in cells (kitty only). */
  cols?: number;
  /** Render height in cells (kitty only). */
  rows?: number;
};

/**
 * Encode `canvas` for the active terminal's image protocol. Returns the
 * escape sequence string. Throws if no protocol is supported and
 * `opts.protocol` isn't supplied.
 */
export function encodeForTerminal(canvas: Canvas, opts: RenderOptions = {}): string {
  const protocol = opts.protocol ?? detectProtocol();
  if (!protocol) {
    throw new Error(
      "no image protocol supported by this terminal " +
        `(TERM=${process.env["TERM"] ?? "?"}, TERM_PROGRAM=${process.env["TERM_PROGRAM"] ?? "?"})`,
    );
  }
  if (protocol === "kitty") {
    return encodeKitty(
      {
        rgba: canvas.pixels,
        width: canvas.width,
        height: canvas.height,
        imageId: opts.imageId ?? 1,
      },
      { cols: opts.cols, rows: opts.rows },
    );
  }
  // sixel
  return encodeSixel({ rgba: canvas.pixels, width: canvas.width, height: canvas.height });
}
