# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] — 2026-05-28

### Added

- **Plugin-native session sync — no scripts.** When connected to Plouto, the
  SessionStart hook now scans local Claude Code JSONL and pushes session +
  turn **metadata** to `/api/ingest/sessions` (`src/plouto/ingest.ts`). This
  replaces the standalone Python adapter for the normal-user path and fixes
  the historical-backfill + multi-machine gaps — every engineer's machine
  feeds the fleet view automatically.
  - **Metadata-only by construction**: only numeric/id/enum/timestamp fields
    are read (via the existing pure extractors); prompt/response/file content
    is never reached for. The server's `extra="forbid"` schema is the backstop.
  - **Per-file byte cursor** (`ingest_upload_state`) — incremental; append-only
    JSONL means new turns = new bytes. Handles long-lived sessions correctly.
  - **Idempotent**: the server upserts on `session_id`/`request_id`, so overlap
    and retries are safe; the cursor only advances on a successful POST.
  - **Bounded per run** (4k turns) so backfill self-completes over a few
    sessions without risking the hook's timeout. No separate backfill path.
  - **90-day window**; **git identity** attached so sessions attribute to the
    right engineer, not the workspace's first user.

### Changed

- **All enforcement writes now route through the reversible apply
  substrate — one write path for local fixes and remote enforcement.**
  `enforce.ts` was a parallel reimplementation of the three operations
  `src/apply/` already provides (`modify-file` / `modify-settings-key` /
  `archive-directory`) — raw `fs` calls, no backup, no revert trail. Each
  enforced action now builds a `Fix` and runs it through `applyFix`, so it
  gets a SHA-256 backup, an operation record, and `boost revert`. Receipts
  carry the `operation_id` back to Plouto.
  - `skill install` → `modify-file`: reversible (revert deletes a created
    SKILL.md or restores an overwritten placeholder).
  - `skill remove` → `archive-directory`: reversible, replacing the
    destructive `rm -rf`.
  - `model recommend` → `modify-settings-key`: reversible.

### Fixed (substrate)

- `applyFix`'s `modify-file` now **creates** files, not just modifies them
  (mirrors `modify-settings-key`'s existing missing-file handling). Revert
  of a created file deletes it, guarded by an `afterHash` check so a later
  hand-edit is never clobbered. Unblocks routing skill-install through the
  substrate; also useful for any future detector that writes a new file.
- `archive-directory` now persists the archived-to path (`archivedToPath`)
  in the operation, so revert removes that exact copy instead of
  reverse-engineering it by content-hash-scanning `~/.boost/archived-skills/`
  (fragile under identical-content archives). Legacy operations without the
  field fall back to the hash-scan.

### Security

- **Path-traversal hardening on the enforcement path.** `StrategyAction.target`
  comes from the Plouto server, which the threat model treats as untrusted
  input — but `enforce.ts` joined it straight onto `~/.claude/skills/<target>`
  with no validation. A target like `../../../tmp/x` escaped the skills dir:
  `removeSkill` would `rm -rf` an arbitrary path and `installSkill` would write
  outside the config tree, turning a compromised or malicious workspace policy
  into arbitrary file delete/write on every engineer's machine. Targets are now
  validated as a single path segment (`assertSafeSegment`) and the resolved
  path is re-checked against the config root (`assertWithinAllowedRoots`) as
  defense-in-depth. Model-recommend writes validate the model id and refuse to
  write outside the user's home tree. Regression tests in
  `tests/plouto/enforce.test.ts`. See [threat-model.md §C7](docs/internals/threat-model.md).
- `enforce.ts` now resolves the skills dir via `claudeHome()` so it honors
  `CLAUDE_CONFIG_DIR` like the rest of boost (previously hardcoded
  `~/.claude`, which also made it untestable).

### Removed

- **Localhost-redirect OAuth flow (`src/plouto/oauth.ts`).** Dead since
  `install.ts` switched to the device-code flow (`device-auth.ts`) in
  0.2.0 — it had no callers and no tests. The localhost-redirect pattern
  assumed the browser could reach `http://localhost:P` on the same box
  the CLI runs on, which is false over SSH (where most pilots run Claude
  Code). See [ADR 003](docs/adr/003-device-code-auth.md) for the full
  rationale. Device-code (RFC 8628) is now the sole browser auth path.

### Fixed

- Stale comment in `install.ts` that still described the
  localhost-redirect flow; the code runs device-code.

## [0.2.0] — 2026-05-22

### Added — Plouto enforcement layer

`boost` is now also Plouto's enforcement tier. When Claude Code starts a
session, a SessionStart hook fetches the workspace's active strategies
from Plouto and applies them on the engineer's machine — skill installs,
recommended-model writes, etc. — then reports back what landed.

- **`boost install --token <plto_…>`** — one-line setup. Merges the
  marketplace registration, plugin enable, and Plouto credentials into
  `~/.claude/settings.json` (or `--managed` for the OS-specific
  managed-settings path). Existing settings preserved via
  `jsonc-parser`'s comment-aware `modify()` API.

- **`boost plouto-sync`** — fetches `/api/plugin/strategies`, dispatches
  each action through the per-kind apply functions (skill install/remove,
  model recommend), POSTs receipts to `/api/plugin/strategies/applied`.
  Best-effort: never blocks Claude Code startup, never throws to the
  hook layer. Silently no-ops when `PLOUTO_TOKEN` isn't set.

- **SessionStart hook** in `boost-plugin/.claude-plugin/plugin.json` —
  `async: true`, 10s timeout. Runs on every Claude Code session start
  so policy changes propagate within ~5s of the next session.

- New plugin id: install with `/plugin install plouto@boost` (the
  marketplace stays "boost"; the plugin within it is named "plouto"
  because that's what it does — enforce Plouto's policies).

Phase 1 scope:
- `skill` rollout/ban — placeholder `SKILL.md` pointing at the source
  repo. Phase 2 will git-pull the actual skill content.
- `model` rollout — writes `<cwd>/.claude/settings.local.json:model`.
- `mcp` / `claude_md` / `prompt` — receipt status `skipped` with note.

### Changed

- Renamed the OSS package and CLI from `loop` to `boost` (`@plouto/boost`, binary `boost`) and moved local state to `~/.boost` / `$BOOST_HOME`.
- Removed Plouto/team sync commands from the OSS CLI so boost is fully local-only with no network code.

### Added

- **`charttui/native`** — pixel-rasterized chart pipeline. Pure-JS
  software rasterizer (anti-aliased line / circle / arc / polygon /
  rect with alpha-over compositing) + kitty graphics protocol encoder
  (APC sequences, deflate-compressed base64 chunked at 4 KB).
  - High-level chart functions: `pieCanvas`, `donutCanvas`,
    `lineChartCanvas` — return a flat RGBA `Canvas` you pipe to
    `encodeImage` for terminal display.
  - Capability detection via env vars: `KITTY_WINDOW_ID`,
    `TERM_PROGRAM=WezTerm|ghostty`, `TERM=xterm-kitty|xterm-ghostty`,
    `KONSOLE_VERSION`.
  - Architecture mirrors vincelwt/gloomberb's chart pipeline.
  - **No fallback** — runs only on kitty graphics terminals (kitty,
    ghostty, WezTerm, Konsole partial). Other terminals get escape
    garbage by design.
- `charttui` — new sibling package at `packages/charttui/`. Tiny,
  framework-agnostic terminal chart library. Eight chart types: horizontal
  bar, vertical bar, stacked bar, progress bar, pie, donut, line, sparkline.
  Each chart is a pure function returning a `Frame` (2D grid of styled
  cells). Adapters: `frameToAnsi` for plain strings, `charttui/react` for
  Ink / opentui components. MIT, zero deps, optional React peer.
- **Pie chart in the Activity tab** — model mix is now a real pie (uses
  the upper-half-block trick for double vertical resolution). Replaces the
  legacy Model mix stacked-bar.
- **Bun workspaces** — root `package.json` declares `packages/*`. `boost`
  imports from `charttui` via `workspace:*`.

### Added

- **Tab navigation** in the TUI: Findings · Activity · Operations · Help.
  Each tab renders only its own content instead of stacking everything
  in one bordered scroll. `←/→` switch tabs (vim `h/l` work too); `1-4`
  jump directly. `?` always opens Help. The findings keyboard map
  (j/k cursor, enter apply, d dismiss, a tidy-ups, q quit) only fires
  when the Findings tab is active.
- **Operations tab** shows the last 20 applies with their state
  (`active` / `reverted`). Read-only — `boost revert` is still the
  subcommand for undoing.

### Changed

- **TUI back on `@opentui/react` + React 19** (final answer; previous
  Ink → opentui → Ink → opentui ping-pong is now resolved). All TUI
  components and chart components use opentui's documented multi-line
  `<text>` idiom: each section is one `<text>` block with `\n`-separated
  content and inline `<span>`-styled segments. This pattern bypasses the
  flex-column overlay bug we hit when each row was its own `<box>`/`<text>`
  child of a column container.
- The new `StackedDailyBar` (model mix × time, tokscale-inspired) renders
  per-row content as inline `<span>` arrays that get embedded into the
  same multi-line text block.
- Bundle: 130 KB (opentui externalized, native FFI loaded from
  `node_modules` at runtime).
- **TUI back on Ink 7 + React 19** (after a brief excursion to opentui).
  opentui's flex column kept overlaying section headers onto first data
  rows; Ink's flex layout is mature and stable. Lost ~700 KB bundle size
  vs the externalized opentui build, but every layout we tried renders
  cleanly with zero workarounds. tokscale uses ratatui (frame-buffer
  rendering, not a layout engine) for the same stability reasons; Ink is
  our equivalent.
- **Stacked-per-day bar chart** combining model mix × daily activity into
  one view (inspired by tokscale's `bar_chart.rs`). Each day's bar is a
  vertical stack of model-colored segments; the height shows total
  uncached spend and the segments show what model produced it. Replaces
  the separate "Model mix" + "Daily uncached tokens" sections.
- **`~/.claude/transcripts/`** added as an additional JSONL discovery
  source. Best-effort — directory may not exist on every Claude Code
  install (didn't on the test environment); discovery skips silently
  when missing.
- New `dailyByModelSeries` activity query and `StackedDailyBar`
  component.
- **Real graphs in the TUI** instead of text-only sparklines and ranked
  lists. New `src/output/tui/charts/`:
  - `HorizontalBar` — proportional bar per row for top tools / MCPs / projects
  - `StackedBar` — single-line color-segmented bar for model mix (with %
    legend underneath)
  - `VerticalBarChart` — multi-line eighth-block bar chart for the daily
    activity series, with auto-sized columns and a peak label
  - `Observed` rewired to use all three; respects terminal width via
    `useTerminalDimensions()`.
- **Layout fix:** every "row" in `Observed`, `FindingsList`, `Help`,
  `ConfirmModal`, `DetailView` is now wrapped in `<box>`. Bare sibling
  `<text>` elements under a column-flex container were being merged into a
  single text buffer by opentui's renderer (the visible bug: section labels
  like "Models" / "Top tools" appearing as 2-character prefixes overlaid on
  the first row). Wrapping each row in `<box>` forces each to be a
  distinct flex item.
- **TUI swapped from Ink to `@opentui/react`.** Same surface, native Zig
  renderer instead of Ink/yoga-layout. JSX intrinsics moved from
  `<Box>`/`<Text>` to `<box>`/`<text>` (lowercase per opentui convention),
  `useInput` became `useKeyboard` with `KeyEvent.name`/`ctrl`/`shift` shape,
  the `useApp().exit()` exit path became `renderer.destroy()` + `process.exit`.
  React peer dep bumped from 18 → 19.2. Bundle dropped from 0.85 MB to 125 KB
  (opentui externalized; loads from `node_modules` at runtime).
- ADR-001 implication: Bun is now strictly required at runtime — opentui's
  core uses `bun:ffi`, and `bun:sqlite` was already a hard dep. The
  `bin/boost.mjs` launcher still works under Node by detecting Bun and
  re-execing; if Bun isn't found, it prints a clear install hint.
- `tsconfig.json`: `jsxImportSource` set to `@opentui/react` so JSX
  intrinsic types (`<box>`, `<text>`, `<span>`, ...) come from opentui.

### Added

- **Activity surface — pulling boost's measurement layer up to ccusage / tokenuse / CodeBurn parity.**
  - New `src/activity.ts` with five queries against the events table:
    `topTools`, `topMcpServers`, `topProjects`, `topSessions`, `dailySeries`.
    Always windowed; cache-read tokens tracked separately from uncached.
  - JSON output gains a top-level `activity` block (additive — schema v2,
    consumers ignore unknown keys): models, top tools, top MCP servers,
    top projects, top sessions, daily series. Documented in
    `docs/json-schema.md`.
  - TUI renders an always-visible `Observed · last 7 days` panel below the
    findings list — model mix, top 5 tools, top 5 MCPs, top 4 projects,
    a 7-day daily uncached-tokens sparkline. The empty-findings case is no
    longer dead air.
  - Plain (non-TTY) renderer surfaces the same Observed block.
  - Six new tests in `tests/activity.test.ts` covering ranking, distinct-
    tool counts, date bucketing, oldest-first ordering, and empty windows.
- **Advisory findings.** `Finding.fixes` is now optional. Detectors that
  observe something worth surfacing but have no automated fix (e.g.
  model-mix recommendations, runtime-injected MCP gaps) emit findings with
  no `fixes`. The TUI hides Apply on advisory findings and excludes them
  from `tidy-ups`; Enter on an advisory finding shows a brief toast.
- **`model-mix-advisory` detector.** Fourth v0.1 strategy. Computes
  per-model uncached-token share over the last 7 days; flags when one
  model accounts for ≥ 80% of spend AND the dominant model isn't already
  Haiku/Sonnet. Severity `high` at ≥ 95% concentration. Provides the full
  per-model breakdown (tokens, requests, share) as evidence + the
  Haiku → Sonnet → Opus escalation guidance in the detail view.
- `summary.modelUsageLastNDays` query helper (per-model uncached + cache
  reads + request count) — also available to consumers via JSON output.

### Added

- **MCP server discovery from every source** Claude Code uses, not just user
  `settings.json`. New `src/data/mcp-sources.ts` walks: user settings,
  `<cwd>/.mcp.json` (with parent walk up to `$HOME`), and recursively under
  `~/.claude/plugins/` for `.mcp.json` and `plugin.json` files (depth ≤ 5,
  cap 200). Each entry records `source` + `sourcePath` so the detector and
  TUI can show *where* a server came from.
- `web_search_requests` and `reasoning_tokens` captured by the JSONL
  normalizer — forward-compatible with the Claude Code OTel surface.
- `usage.speed` (`fast` / `standard`) captured for v0.2 model-mix analysis.
- New `src/summary.ts:tokenBreakdownSince` helper for per-token-type sums
  over arbitrary windows.
- Four new tests covering project `.mcp.json` discovery, plugin-server vs
  user-settings precedence, the new per-server install grace, and
  recursive subagent JSONL discovery.

### Changed

- **Summary block reshaped (JSON schema_version: 1 → 2).** The single
  misleading `tokens_last_7_days` is gone. Replaced by per-token-type
  fields (`input` / `output` / `cache_creation` / `cache_read`),
  `uncached_tokens_last_7_days`, and `cache_hit_rate_last_7_days`. Header
  in the TUI and plain output now shows uncached + cache-read separately
  with a hit-rate badge — no more 716M-when-you-actually-spent-150M.
- `unused-mcp-disable` strategy bumped to v2: now consumes the merged MCP
  list from `mcp-sources.ts`. Fix payloads still target only
  `user-settings` entries (project-level and plugin-level files are often
  shared and writing them is out of v0.1 scope), but project- and
  plugin-defined servers are surfaced in evidence.
- **Per-server install grace** replaces the old wholesale "skip the
  detector if settings.json was edited recently" gate. A server is now
  only skipped if its source file is < 7 days old AND it has no events
  *ever*. Editing one MCP entry no longer silences the whole detector.

### Maintainability

- `Finding.fix + subFixes?` collapsed to `Finding.fixes: NonEmpty<Fix>`. The
  CLI walks one list; the apply layer issues one `Operation` per fix.
- Deep prototype-pollution sanitize on parsed `settings.json` — strips
  `__proto__`/`constructor`/`prototype` at every depth, not just top-level.
- `assertNever` defaults on every union switch (`applyFix`,
  `backupBeforeWrite`, `restoreFromBackup`). Adding a new variant fails at
  compile time until every handler updates.
- Per-strategy unit tests at `tests/strategies/*.test.ts` covering cold-start
  gates, severity boundaries, signal requirements, and savings clamps. New
  test helpers in `tests/helpers/detector-context.ts` for synthesising
  `DetectorContext` against an in-memory DB.
- `boost --check` now distinguishes "no Claude Code data yet" (exit 3, with a
  first-run hint) from "looks fine" (exit 0). Removes the misleading
  "✓ good shape" message on first-run terminals.
- CLI `VERSION` reads from `package.json` via JSON import; can't drift.
- `package.json` publish hygiene: `repository`, `homepage`, `bugs`,
  `keywords`, `author`, `publishConfig.access`/`provenance`. Dropped unused
  `ink-select-input`/`ink-spinner`. Moved `react-devtools-core` to
  `devDependencies` (ink only loads it when `DEV=true`). Dropped the
  `peerDependencies.typescript` (wrong on a CLI; moved to dev).
- CI: `bun audit` step + smoke-test of the bundled binary on a fresh
  `BOOST_HOME`. Release workflow asserts the git tag matches `package.json`
  before publishing.
- `docs/writing-a-strategy.md` now documents `DetectorContext` shape, useful
  event columns, and includes a worked example with the test helpers.
- README comparison table linked + softened ("design difference, not a
  maturity claim"). Privacy claim tightened to "never persisted, transmitted,
  or analyzed" — defensible against reading-bytes-to-extract-metadata.
- Bug-report template asks for `BOOST_HOME` / `CLAUDE_CONFIG_DIR` / Bun version.
- `output/plain.ts` uses `chalk` instead of raw ANSI escapes.
- Magic numbers extracted to named consts (`MAX_IMPORT_DEPTH`,
  `MAX_PROJECT_ANCESTOR_WALK`).
- `orchestrate.ts` no longer mutates `RunnerResult`; pruning failures are
  surfaced via `warn()` instead of silently swallowed.
- Removed dead `void X;` keepalive imports.

### Security

- Hash-verify backup integrity on every revert (file, settings-key, directory).
  `BackupRef` now records `backupHash`; revert refuses with a tamper error if
  the on-disk backup differs.
- Refuse symlinked ancestors on every write target (close TOCTOU between path
  canonicalization and rename). `atomicWriteFile` accepts a `safeRoot` and
  checks each intermediate directory.
- Tar extraction tightened: reject every typeflag except `0` (file) and `5`
  (dir), reject absolute and parent-traversal entry names, refuse to follow
  symlinks at the leaf or any ancestor, write with `O_NOFOLLOW`.
- Race-check now hashes the file (sha256) instead of comparing mtime/size —
  catches sub-millisecond writes that produce identical sizes.
- `archive-directory` revert restores from tarball **and** removes the
  moved-to archive copy — previously left both locations existing.

### Changed

- `claude-md-bloat`: now operates only on the global `~/.claude/CLAUDE.md`,
  never project-level files. Marked `safeToApply: false` so it requires an
  explicit per-finding apply (excluded from `tidy-ups`).
- `unused-skill-archive`: requires a real `skill_activated` event signal.
  Returns `null` until the OTel ingest path lands in v0.2 — the v0.1 fallback
  flagged everything for users with ≥5 skills, which was a footgun.
- Savings math clamped to ≤ 99.9%; uses un-cached weekly tokens
  (`input + output + cache_creation`, excludes `cache_read`) as denominator
  and discounts by measured cache hit rate.

### Added

- Node-runnable launcher at `bin/boost.mjs` — npm `bin` now points here.
  Detects Bun, re-execs the bundle, prints a clear install hint when Bun is
  missing.
- `prepublishOnly` script: runs typecheck + tests + build before any publish.
- Initial scaffolding: TypeScript + Bun + Ink CLI/TUI
- JSONL ingestion pipeline (discovery, streaming parser, normalizer, incremental ingest)
- Static config readers (CLAUDE.md, settings.json, skills, plugins)
- Strategy harness with three v0.1 detectors:
  - `unused-mcp-disable`
  - `claude-md-bloat`
  - `unused-skill-archive`
- Backup engine with atomic writes, no-symlink-follow, sha256 integrity
- Apply / revert system with race detection
- `boost --json`, `boost --check`, plain ANSI fallback
- Ink-based TUI: findings list, detail view, confirm modal, apply progress, dismiss, help
- `boost revert` subcommand
- Threat model and sharp-edges documentation
