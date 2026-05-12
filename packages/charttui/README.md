# charttui

> Tiny, framework-agnostic terminal charts. **Bar, stacked bar, progress, pie, donut, line, sparkline.** Returns an ANSI string, or React components for [Ink](https://github.com/vadimdemedes/ink) / [opentui](https://github.com/sst/opentui).

```sh
bun add charttui
# or
npm install charttui
```

## Why

The JS terminal-UI ecosystem ships layout (Ink, opentui) but no charts. `blessed-contrib` has them but is unmaintained and incompatible with React renderers. `ervy` is from 2022. This is a maintained, dependency-free, Bun-native option.

## Quick start (plain string output)

```ts
import { horizontalBar, frameToAnsi } from "charttui";

const frame = horizontalBar(
  [
    { label: "Bash", value: 700 },
    { label: "Edit", value: 580 },
    { label: "Read", value: 390 },
  ],
  { width: 60, barColor: "cyan" },
);

console.log(frameToAnsi(frame));
```

## Quick start (React, for opentui or Ink)

```tsx
import { Pie, HorizontalBar } from "charttui/react";

function Dashboard() {
  return (
    <box flexDirection="column">
      <Pie
        radius={6}
        segments={[
          { label: "Opus", value: 19_000_000, color: "cyan" },
          { label: "Haiku", value: 170_000, color: "magenta" },
        ]}
      />
      <HorizontalBar
        width={60}
        rows={[
          { label: "Bash", value: 700, valueLabel: "calls" },
          { label: "Edit", value: 580, valueLabel: "calls" },
        ]}
      />
    </box>
  );
}
```

## Charts

| Chart | Function | React component | Use case |
|---|---|---|---|
| Horizontal bar | `horizontalBar(rows, opts)` | `<HorizontalBar />` | Top-N rankings (tools, MCPs, projects) |
| Vertical bar | `verticalBar(points, opts)` | `<VerticalBar />` | Time-series (daily/hourly buckets) |
| Stacked bar | `stackedBar(segments, opts)` | `<StackedBar />` | Share-of-total in one row |
| Progress bar | `progressBar(0..1, opts)` | `<ProgressBar />` | Single value vs target |
| Pie | `pie(segments, opts)` | `<Pie />` | Categorical breakdown |
| Donut | `donut(segments, opts)` | `<Donut />` | Pie with a hole |
| Line | `lineChart(series, opts)` | `<LineChart />` | One or more series over time |
| Sparkline | `sparkline(values, opts)` | `<Sparkline />` | Inline single-row trend |

## Architecture

Each chart is a **pure function** returning a `Frame` — a 2D grid of styled cells. Rendering adapters (`frameToAnsi`, `<FrameView>`) consume Frames.

```
data + opts ──► chart fn ──► Frame ──► frameToAnsi → string
                                   └─► <FrameView>  → JSX
```

This means:
- Same chart works in any context (CLI output, Ink TUI, opentui TUI, web canvas if you write that adapter).
- You can compose / stack / pad Frames with the helpers in `index.ts` (`vstack`, `padFrameWidth`).
- Chart logic is testable without spinning up a renderer.

## Pie chart resolution

The pie uses the upper-half-block trick (`▀`) to double vertical resolution: each text row encodes two pixel rows via independent foreground / background colors. A 6-row pie has effectively 12 pixel rows.

For terminals that don't render half-blocks well, set `highRes: false` to fall back to single-block rendering.

## Colors

`Color` is a union of named terminal colors:

```ts
"black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
| "gray"
| "brightRed" | "brightGreen" | "brightYellow" | "brightBlue"
| "brightMagenta" | "brightCyan" | "brightWhite"
```

The ANSI renderer maps these to standard 16-color codes. The React adapter passes them through to `<span fg={...}>` — Ink and opentui both accept these names.

## Status

v0.1 — usable but pre-1.0. API may evolve. Issues and PRs welcome.

## License

MIT
