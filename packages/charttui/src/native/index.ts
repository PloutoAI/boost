/**
 * charttui/native — pixel-rasterized charts for graphics-capable terminals.
 *
 * Pure JS, zero native deps. Pipeline:
 *
 *   data → rasterizer (Canvas/RGBA) → kitty graphics encoder → terminal
 *
 * Usage:
 *
 *   import { pieCanvas, encodeImage, detectSupport } from "charttui/native";
 *
 *   if (!detectSupport()) {
 *     // Bail or show your own message — we do not fall back to text.
 *   }
 *
 *   const canvas = pieCanvas([
 *     { label: "Opus", value: 67, color: "#3DDBD9" },
 *     { label: "Sonnet", value: 22, color: "#F8C471" },
 *     { label: "Haiku", value: 11, color: "#D462E3" },
 *   ]);
 *
 *   process.stdout.write(encodeImage({
 *     rgba: canvas.pixels,
 *     width: canvas.width,
 *     height: canvas.height,
 *     imageId: 1,
 *   }, { cols: 30, rows: 15 }));
 *
 * Render targets supported via the kitty graphics protocol: kitty,
 * ghostty, WezTerm, Konsole (partial). Other terminals will print escape
 * garbage. There is intentionally no fallback.
 */
export {
  type Canvas,
  type RGBA,
  createCanvas,
  rgba,
  drawLine,
  drawPolyline,
  fillCircle,
  strokeCircle,
  fillArc,
  fillRect,
  fillPolygon,
} from "./rasterizer.ts";

export {
  type KittyImage,
  type KittyPlacement,
  buildCapabilityProbe,
  encodeTransmit,
  encodePlacement,
  encodeImage,
  detectSupport,
} from "./kitty.ts";

export {
  type SixelImage,
  encodeSixel,
  detectSixelSupport,
} from "./sixel.ts";

export {
  type Protocol,
  type RenderOptions,
  detectProtocol,
  encodeForTerminal,
} from "./protocol.ts";

export {
  type NativePieSegment,
  type NativePieOptions,
  type NativeLineSeries,
  type NativeLineChartOptions,
  pieCanvas,
  donutCanvas,
  lineChartCanvas,
} from "./charts.ts";
