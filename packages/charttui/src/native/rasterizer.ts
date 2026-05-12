/**
 * Pure-JS software rasterizer with anti-aliased line/circle/arc/polygon
 * drawing. Operates on a flat RGBA `Uint8Array` (4 bytes per pixel).
 *
 * Anti-aliasing: edge coverage is computed via `smoothstep(d, half, half+1)`
 * giving sub-pixel-accurate alpha. Pixels are composited with proper
 * alpha-over (the destination's alpha is preserved when both pixels are
 * partially transparent).
 *
 * No external deps. Adapted from the rasterizer pattern in
 * vincelwt/gloomberb (chart-rasterizer.ts).
 */

export type RGBA = { r: number; g: number; b: number; a: number };

export type Canvas = {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array; // RGBA, length = w*h*4
};

export function createCanvas(width: number, height: number, fill?: RGBA): Canvas {
  const pixels = new Uint8Array(width * height * 4);
  if (fill) {
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = fill.r;
      pixels[i + 1] = fill.g;
      pixels[i + 2] = fill.b;
      pixels[i + 3] = fill.a;
    }
  }
  return { width, height, pixels };
}

/** Parse `#RRGGBB` or `#RRGGBBAA`. Throws on bad input. */
export function rgba(hex: string, alpha = 1): RGBA {
  const h = hex.replace("#", "");
  if (h.length !== 6 && h.length !== 8) throw new Error(`bad hex color: ${hex}`);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const aHex = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a: Math.round(clamp(aHex * alpha, 0, 1) * 255) };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function smoothstep(edge0: number, edge1: number, value: number): number {
  const range = edge1 - edge0;
  if (range === 0) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / range, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Alpha-over compositing of `src` onto pixel (x,y) with `coverage`. */
function blendPixel(c: Canvas, x: number, y: number, src: RGBA, coverage = 1): void {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const a = clamp((src.a / 255) * coverage, 0, 1);
  if (a <= 0) return;

  const idx = (y * c.width + x) * 4;
  const dstA = c.pixels[idx + 3]! / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;

  const dstFactor = (dstA * (1 - a)) / outA;
  const srcFactor = a / outA;
  c.pixels[idx] = Math.round(src.r * srcFactor + c.pixels[idx]! * dstFactor);
  c.pixels[idx + 1] = Math.round(src.g * srcFactor + c.pixels[idx + 1]! * dstFactor);
  c.pixels[idx + 2] = Math.round(src.b * srcFactor + c.pixels[idx + 2]! * dstFactor);
  c.pixels[idx + 3] = Math.round(outA * 255);
}

/** Anti-aliased line, thickness in pixels. */
export function drawLine(
  c: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RGBA,
  thickness = 1.5,
): void {
  const half = thickness / 2;
  const minX = Math.floor(Math.min(x0, x1) - half - 1);
  const maxX = Math.ceil(Math.max(x0, x1) + half + 1);
  const minY = Math.floor(Math.min(y0, y1) - half - 1);
  const maxY = Math.ceil(Math.max(y0, y1) + half + 1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const segLen2 = dx * dx + dy * dy || 1;

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const t = clamp(((cx - x0) * dx + (cy - y0) * dy) / segLen2, 0, 1);
      const nx = x0 + dx * t;
      const ny = y0 + dy * t;
      const dist = Math.hypot(cx - nx, cy - ny);
      const coverage = 1 - smoothstep(half, half + 1, dist);
      if (coverage > 0) blendPixel(c, px, py, color, coverage);
    }
  }
}

/** Anti-aliased polyline from a list of (x, y) points. */
export function drawPolyline(c: Canvas, points: ReadonlyArray<readonly [number, number]>, color: RGBA, thickness = 1.5): void {
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    drawLine(c, x0, y0, x1, y1, color, thickness);
  }
}

/** Filled circle with AA rim. */
export function fillCircle(c: Canvas, cx: number, cy: number, r: number, color: RGBA): void {
  const minX = Math.floor(cx - r - 1);
  const maxX = Math.ceil(cx + r + 1);
  const minY = Math.floor(cy - r - 1);
  const maxY = Math.ceil(cy + r + 1);
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
      const coverage = 1 - smoothstep(r - 0.5, r + 0.5, d);
      if (coverage > 0) blendPixel(c, px, py, color, coverage);
    }
  }
}

/** Stroke a circle outline. */
export function strokeCircle(c: Canvas, cx: number, cy: number, r: number, color: RGBA, thickness = 1.5): void {
  const half = thickness / 2;
  const outerR = r + half;
  const minX = Math.floor(cx - outerR - 1);
  const maxX = Math.ceil(cx + outerR + 1);
  const minY = Math.floor(cy - outerR - 1);
  const maxY = Math.ceil(cy + outerR + 1);
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const d = Math.abs(Math.hypot(px + 0.5 - cx, py + 0.5 - cy) - r);
      const coverage = 1 - smoothstep(half, half + 1, d);
      if (coverage > 0) blendPixel(c, px, py, color, coverage);
    }
  }
}

/**
 * Filled circular sector (pie wedge): center to arc between `fromAngle`
 * and `toAngle`, both clockwise from 12 o'clock in radians.
 *
 * Points inside the sector are filled with AA at both the radial edges
 * and the outer rim. `innerR > 0` carves a donut hole.
 */
export function fillArc(
  c: Canvas,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  fromAngle: number,
  toAngle: number,
  color: RGBA,
): void {
  // Normalize angle range to [0, 2π).
  let a0 = ((fromAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  let a1 = ((toAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  // Handle wrap-around by emitting two arcs if needed.
  if (a1 < a0) {
    fillArc(c, cx, cy, outerR, innerR, a0, Math.PI * 2 - 1e-9, color);
    fillArc(c, cx, cy, outerR, innerR, 0, a1, color);
    return;
  }
  if (a1 - a0 < 1e-9) return;

  const minX = Math.floor(cx - outerR - 1);
  const maxX = Math.ceil(cx + outerR + 1);
  const minY = Math.floor(cy - outerR - 1);
  const maxY = Math.ceil(cy + outerR + 1);

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const sx = px + 0.5 - cx;
      const sy = py + 0.5 - cy;
      const dist = Math.hypot(sx, sy);

      // Radial coverage.
      const outerCoverage = 1 - smoothstep(outerR - 0.5, outerR + 0.5, dist);
      const innerCoverage = innerR > 0 ? smoothstep(innerR - 0.5, innerR + 0.5, dist) : 1;
      const radialCoverage = outerCoverage * innerCoverage;
      if (radialCoverage <= 0) continue;

      // Angle (clockwise from 12 o'clock).
      let ang = Math.atan2(sx, -sy);
      if (ang < 0) ang += Math.PI * 2;

      // Angular coverage with 1px-equivalent feathering at the radial edges.
      // Convert pixel feather to angular feather: ~ 1 / dist (at the rim).
      const feather = dist > 0 ? 1 / dist : 0.05;
      const angularCoverage =
        smoothstep(a0 - feather, a0 + feather, ang) *
        (1 - smoothstep(a1 - feather, a1 + feather, ang));
      if (angularCoverage <= 0) continue;

      blendPixel(c, px, py, color, radialCoverage * angularCoverage);
    }
  }
}

/** Solid rectangle fill. */
export function fillRect(c: Canvas, x: number, y: number, w: number, h: number, color: RGBA): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(c.width, Math.ceil(x + w));
  const y1 = Math.min(c.height, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      blendPixel(c, px, py, color);
    }
  }
}

/**
 * Filled polygon, even-odd rule, with AA edges via line drawing on the
 * polygon outline (cheap "fill then outline" approach for crisp edges).
 */
export function fillPolygon(c: Canvas, points: ReadonlyArray<readonly [number, number]>, color: RGBA): void {
  if (points.length < 3) return;
  let minY = points[0]![1];
  let maxY = points[0]![1];
  for (const [, py] of points) {
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(c.height - 1, Math.ceil(maxY));

  // Even-odd scan-line fill.
  for (let py = yStart; py <= yEnd; py++) {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i]!;
      const [x1, y1] = points[(i + 1) % points.length]!;
      if ((y0 <= py && y1 > py) || (y1 <= py && y0 > py)) {
        const t = (py + 0.5 - y0) / (y1 - y0);
        xs.push(x0 + t * (x1 - x0));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.floor(xs[i]!));
      const xb = Math.min(c.width - 1, Math.ceil(xs[i + 1]!));
      for (let px = xa; px <= xb; px++) blendPixel(c, px, py, color);
    }
  }

  // AA the outline by overdrawing thin lines on each edge.
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    drawLine(c, x0, y0, x1, y1, color, 1);
  }
}
