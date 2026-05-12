/**
 * Strategy contract — the shape every detector module conforms to.
 *
 * `apply` and `revert` take operation context separately so the strategy
 * file stays focused on logic; the actual file I/O is in `src/apply/`.
 */
import type { Database as BunDatabase } from "bun:sqlite";
import type { Finding } from "./types.ts";
import type { ClaudeMdFile } from "./data/claude-md.ts";
import type { ClaudeSettings } from "./data/settings-json.ts";
import type { McpServerSource } from "./data/mcp-sources.ts";
import type { Skill } from "./data/skills.ts";
import type { Plugin } from "./data/plugins.ts";

/** Snapshot of static config, computed once per detection run. */
export type ConfigSnapshot = {
  claudeMdFiles: ClaudeMdFile[];
  settings: ClaudeSettings | null;
  /**
   * Merged MCP servers from every source boost knows about — user
   * `settings.json`, project `.mcp.json` (with ancestor walk), plugin
   * `.mcp.json`, and plugin manifests. Each entry records `source` and
   * `sourcePath`. Detectors should reason about *this*, not
   * `settings.mcpServers`, which only covers the single user file.
   */
  mcpServers: McpServerSource[];
  skills: Skill[];
  plugins: Plugin[];
};

/** Query helper passed to detectors. */
export type EventQuery = {
  /**
   * Return rows from `events`. Use this rather than poking `db` directly
   * so query patterns stay reviewable.
   */
  db: BunDatabase;
};

export type DetectorContext = {
  events: EventQuery;
  config: ConfigSnapshot;
  now: Date;
  recentDismissals: Set<string>;
  /** Cold-start gate. Strategies that need behavior history should suppress when low. */
  daysOfDataAvailable: number;
};

export type StrategyDefinition = {
  id: string;
  version: number;
  category: "clear-wins" | "trade-offs";
  defaultSeverity: "high" | "medium" | "low";
  safeToApply: boolean;
  /** Headline rendered in the list; called per-finding so it can incorporate counts. */
  title: (finding: Finding) => string;
  /**
   * Run the detector against the snapshot. Three shapes accepted:
   *
   *  - `null` — nothing to surface this run.
   *  - `Finding` — single finding (aggregate detectors: claude-md-bloat,
   *    model-mix-advisory, etc.).
   *  - `Finding[]` — one finding per offence (per-session detectors like
   *    retry-storm, subagent-cost; per-feature detectors that want each
   *    item separately rankable).
   *
   * Returning an empty array is treated the same as null — the runner
   * filters it out before ranking.
   */
  detect: (ctx: DetectorContext) => Finding | Finding[] | null;
  /** Long-form copy shown in the detail view. */
  explain: (finding: Finding) => string;
};
