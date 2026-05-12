/**
 * charttui — tiny, framework-agnostic terminal charts.
 *
 * Each chart is a pure function returning a `Frame` (2D grid of styled
 * cells). Render to an ANSI string with `frameToAnsi`, or use the React
 * adapter (`charttui/react`) for Ink / opentui.
 */
export type {
  Cell,
  Color,
  Frame,
  WidthSpec,
  HeightSpec,
} from "./types.ts";
export { EMPTY_CELL, blankFrame, vstack, padFrameWidth } from "./types.ts";

export { horizontalBar, type HorizontalBarRow, type HorizontalBarOptions } from "./charts/horizontal-bar.ts";
export { verticalBar, type VerticalBarPoint, type VerticalBarOptions } from "./charts/vertical-bar.ts";
export { stackedBar, type StackedBarSegment, type StackedBarOptions } from "./charts/stacked-bar.ts";
export { progressBar, type ProgressBarOptions } from "./charts/progress-bar.ts";
export { pie, donut, type PieSegment, type PieOptions } from "./charts/pie.ts";
export { lineChart, type LineSeries, type LineChartOptions } from "./charts/line.ts";
export { sparkline, type SparklineOptions } from "./charts/sparkline.ts";

export { frameToAnsi, type AnsiOptions } from "./render/ansi.ts";
