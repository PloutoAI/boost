/**
 * Detector runner. Loads context, walks the registry, captures findings,
 * tolerates per-strategy failures.
 */
import type { Database as BunDatabase } from "bun:sqlite";
import type { Finding } from "./types.ts";
import type { DetectorContext, StrategyDefinition } from "./strategy.ts";
import { activeDismissals } from "./dismiss.ts";
import { daysOfDataAvailable } from "./data/jsonl-ingest.ts";
import { readClaudeMdFiles } from "./data/claude-md.ts";
import { readSettings } from "./data/settings-json.ts";
import { discoverMcpServers } from "./data/mcp-sources.ts";
import { enumerateSkills } from "./data/skills.ts";
import { enumeratePlugins } from "./data/plugins.ts";
import { strategies } from "./strategies/index.ts";

export type RunnerOptions = {
  showAll?: boolean;
  warn?: (msg: string) => void;
  cwd?: string;
};

export type RunnerResult = {
  findings: Finding[];
  context: DetectorContext;
  warnings: string[];
};

/** Execute every registered strategy against the current context. */
export function runDetectors(db: BunDatabase, opts: RunnerOptions = {}): RunnerResult {
  const warnings: string[] = [];
  const warn = opts.warn ?? ((m: string) => warnings.push(m));

  const settingsResult = readSettings();
  if (settingsResult.warning) warn(settingsResult.warning);

  const settings = settingsResult.settings;
  const mcpServers = discoverMcpServers({
    cwd: opts.cwd,
    userSettings: settings?.mcpServers,
    userSettingsPath: settings?.path ?? null,
  });

  const ctx: DetectorContext = {
    events: { db },
    config: {
      claudeMdFiles: readClaudeMdFiles(opts.cwd),
      settings,
      mcpServers,
      skills: enumerateSkills(),
      plugins: enumeratePlugins(),
    },
    now: new Date(),
    recentDismissals: opts.showAll ? new Set() : activeDismissals(db),
    daysOfDataAvailable: daysOfDataAvailable(db),
  };

  const findings: Finding[] = [];
  for (const strategy of strategies) {
    if (!opts.showAll && ctx.recentDismissals.has(strategy.id)) continue;
    let result: Finding | Finding[] | null = null;
    try {
      result = strategy.detect(ctx);
    } catch (err) {
      warn(`strategy ${strategy.id} threw during detect: ${(err as Error).message}`);
      continue;
    }
    if (result === null) continue;
    if (Array.isArray(result)) {
      for (const f of result) findings.push(f);
    } else {
      findings.push(result);
    }
  }

  return { findings, context: ctx, warnings };
}

