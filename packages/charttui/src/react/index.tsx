/**
 * React adapter — converts charttui Frames into opentui `<text>` blocks.
 *
 * One `<box>` containing one `<text wrapMode="none">` per chart, with
 * `<span>`-styled runs. Lines are separated by `\n`. This is the opentui
 * idiom that avoids the flex-column overlay bug.
 *
 * If you're using Ink instead, the same Frame can be rendered via your
 * own `<Box flexDirection="column">{rows.map(<Text>...)}</Box>` adapter —
 * see the README for an example.
 */
import * as React from "react";
import {
  horizontalBar,
  verticalBar,
  stackedBar,
  progressBar,
  pie,
  donut,
  lineChart,
  sparkline,
  type HorizontalBarRow,
  type HorizontalBarOptions,
  type VerticalBarPoint,
  type VerticalBarOptions,
  type StackedBarSegment,
  type StackedBarOptions,
  type ProgressBarOptions,
  type PieSegment,
  type PieOptions,
  type LineSeries,
  type LineChartOptions,
  type SparklineOptions,
  type Cell,
  type Frame,
} from "../index.ts";

export type FrameViewProps = {
  frame: Frame;
};

/**
 * Render an arbitrary Frame as an opentui `<text>` block. Adjacent cells
 * with identical styling are coalesced into a single `<span>` to keep
 * the React tree shallow.
 */
export function FrameView({ frame }: FrameViewProps): React.ReactNode {
  return (
    <text wrapMode="none">
      {frame.map((row, ri) => (
        <React.Fragment key={ri}>
          {coalesceRow(row).map((seg, si) => (
            <span
              key={si}
              fg={seg.fg as string | undefined}
              bg={seg.bg as string | undefined}
              attributes={attrsFor(seg.bold, seg.dim)}
            >
              {seg.text}
            </span>
          ))}
          {ri < frame.length - 1 ? "\n" : ""}
        </React.Fragment>
      ))}
    </text>
  );
}

type CoalescedSegment = {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
};

function coalesceRow(row: Cell[]): CoalescedSegment[] {
  if (row.length === 0) return [{ text: " " }];
  const out: CoalescedSegment[] = [];
  let cur: CoalescedSegment | null = null;
  for (const c of row) {
    if (
      cur &&
      cur.fg === c.fg &&
      cur.bg === c.bg &&
      cur.bold === c.bold &&
      cur.dim === c.dim
    ) {
      cur.text += c.char;
    } else {
      cur = {
        text: c.char,
        fg: c.fg as string | undefined,
        bg: c.bg as string | undefined,
        bold: c.bold,
        dim: c.dim,
      };
      out.push(cur);
    }
  }
  return out;
}

// opentui uses bitflag attributes for bold/dim/etc. Bit 0=bold, 1=dim.
const ATTR_BOLD = 1 << 0;
const ATTR_DIM = 1 << 1;

function attrsFor(bold?: boolean, dim?: boolean): number | undefined {
  let v = 0;
  if (bold) v |= ATTR_BOLD;
  if (dim) v |= ATTR_DIM;
  return v === 0 ? undefined : v;
}

// ─── Convenience wrappers — call the chart fn and pipe through FrameView ────

export function HorizontalBar({
  rows,
  ...opts
}: { rows: HorizontalBarRow[] } & HorizontalBarOptions): React.ReactNode {
  return <FrameView frame={horizontalBar(rows, opts)} />;
}

export function VerticalBar({
  points,
  ...opts
}: { points: VerticalBarPoint[] } & VerticalBarOptions): React.ReactNode {
  return <FrameView frame={verticalBar(points, opts)} />;
}

export function StackedBar({
  segments,
  ...opts
}: { segments: StackedBarSegment[] } & StackedBarOptions): React.ReactNode {
  return <FrameView frame={stackedBar(segments, opts)} />;
}

export function ProgressBar({
  value,
  ...opts
}: { value: number } & ProgressBarOptions): React.ReactNode {
  return <FrameView frame={progressBar(value, opts)} />;
}

export function Pie({
  segments,
  ...opts
}: { segments: PieSegment[] } & PieOptions): React.ReactNode {
  return <FrameView frame={pie(segments, opts)} />;
}

export function Donut({
  segments,
  ...opts
}: { segments: PieSegment[] } & PieOptions): React.ReactNode {
  return <FrameView frame={donut(segments, opts)} />;
}

export function LineChart({
  series,
  ...opts
}: { series: LineSeries[] } & LineChartOptions): React.ReactNode {
  return <FrameView frame={lineChart(series, opts)} />;
}

export function Sparkline({
  values,
  ...opts
}: { values: number[] } & SparklineOptions): React.ReactNode {
  return <FrameView frame={sparkline(values, opts)} />;
}
