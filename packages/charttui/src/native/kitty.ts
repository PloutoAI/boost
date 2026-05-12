/**
 * Kitty terminal graphics protocol encoder.
 *
 * Wraps an RGBA pixel buffer in APC sequences (`\x1b_G…\x1b\\`) so a
 * graphics-capable terminal renders it as a real image. Payload is
 * deflate-compressed and chunked at 4 KB per APC frame so escape
 * sequences stay below tmux's passthrough limits.
 *
 * Protocol reference:
 *   https://sw.kovidgoyal.net/kitty/graphics-protocol/
 *
 * Supported in production by:
 *   kitty, ghostty, WezTerm, Konsole (partial)
 *
 * Adapted from the protocol layer in vincelwt/gloomberb (kitty-protocol.ts).
 */
import { deflateSync } from "node:zlib";

const APC_START = "\x1b_G";
const APC_END = "\x1b\\";
const DEFAULT_CHUNK = 4096;

export type KittyImage = {
  /** RGBA pixel data, length = width * height * 4. */
  rgba: Uint8Array;
  width: number;
  height: number;
  /**
   * Image ID — clients use this to refer to a transmitted image when
   * placing or deleting. Pick something unique per image.
   */
  imageId: number;
};

export type KittyPlacement = {
  imageId: number;
  /** Optional placement ID — multiple placements of the same image. */
  placementId?: number;
  /**
   * Z-index. Higher draws on top. Use a positive value to render above
   * cell text.
   */
  zIndex?: number;
  /**
   * Cell columns the image should span. The terminal scales the image to
   * fit. If unspecified, the image renders at its natural pixel size.
   */
  cols?: number;
  rows?: number;
};

/**
 * Build an `\x1b[c` Device Attributes 1 query plus a tiny kitty graphics
 * probe. Capable terminals respond with a kitty-graphics ack; everyone
 * else just answers DA1. Use this to detect support.
 */
export function buildCapabilityProbe(probeImageId = 31): string {
  // 1×1 transparent pixel as a "data" query — `q=2` suppresses success
  // ack but the response will still come through if the terminal speaks
  // kitty graphics.
  return wrap(`i=${probeImageId},s=1,v=1,a=q,t=d,f=24`, "AAAA") + "\x1b[c";
}

/**
 * Encode a kitty graphics "transmit" sequence — pushes the image to the
 * terminal under `imageId`. Does not display it (use `encodePlacement`).
 *
 * The payload is: zlib-compressed RGBA → base64 → chunks of 4 KB → each
 * chunk wrapped in its own APC frame with `m=1` (more chunks coming) or
 * `m=0` (last chunk).
 */
export function encodeTransmit(img: KittyImage, chunkSize = DEFAULT_CHUNK): string {
  const compressed = deflateSync(Buffer.from(img.rgba));
  const base64 = compressed.toString("base64");
  const chunks = chunkBase64(base64, chunkSize);
  if (chunks.length === 0) return "";

  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const m = isLast ? 0 : 1;
    const control = i === 0
      ? buildControl([
          ["a", "t"], // action: transmit
          ["f", 32], // format: 32-bit RGBA
          ["t", "d"], // transmit medium: direct (escape sequence payload)
          ["o", "z"], // compression: zlib (deflate)
          ["s", img.width],
          ["v", img.height],
          ["i", img.imageId],
          ["q", 2], // suppress success/error response
          ["m", m],
        ])
      : buildControl([["m", m]]);
    out.push(wrap(control, chunks[i]!));
  }
  return out.join("");
}

/**
 * Encode a "place" sequence — display a previously-transmitted image at
 * the current cursor position.
 */
export function encodePlacement(p: KittyPlacement): string {
  return wrap(
    buildControl([
      ["a", "p"], // action: place
      ["i", p.imageId],
      ["p", p.placementId ?? null],
      ["c", p.cols ?? null],
      ["r", p.rows ?? null],
      ["z", p.zIndex ?? null],
      ["q", 2],
    ]),
  );
}

/** Convenience: transmit + place in one go. */
export function encodeImage(img: KittyImage, place: Omit<KittyPlacement, "imageId"> = {}): string {
  return encodeTransmit(img) + encodePlacement({ ...place, imageId: img.imageId });
}

/**
 * Detect kitty graphics support via env vars (cheap, synchronous, no
 * terminal probe needed). Returns true for terminals known to support
 * the protocol.
 */
export function detectSupport(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["KITTY_WINDOW_ID"]) return true; // kitty itself
  const program = env["TERM_PROGRAM"];
  if (program === "WezTerm") return true;
  if (program === "ghostty") return true;
  if (env["TERM"] === "xterm-kitty") return true;
  if (env["TERM"] === "xterm-ghostty") return true;
  if (env["KONSOLE_VERSION"]) return true; // partial support
  return false;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function wrap(control: string, payload = ""): string {
  return `${APC_START}${control};${payload}${APC_END}`;
}

function buildControl(entries: ReadonlyArray<readonly [string, string | number | null | undefined]>): string {
  return entries
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

function chunkBase64(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
