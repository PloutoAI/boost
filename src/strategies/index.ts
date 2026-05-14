/**
 * Strategy registry. Sorted alphabetically by ID.
 *
 * Adding a new strategy is intentionally a registry edit — we want the PR
 * that adds a detector to be visibly listed.
 */
import type { StrategyDefinition } from "../strategy.ts";
import autoCompactOveruseAdvisory from "./auto-compact-overuse-advisory.ts";
import claudeMdBloat from "./claude-md-bloat.ts";
import modelMixAdvisory from "./model-mix-advisory.ts";
import noSkillsAdvisory from "./no-skills-advisory.ts";
import retryStormAdvisory from "./retry-storm-advisory.ts";
import shellOutputVerboseAdvisory from "./shell-output-verbose-advisory.ts";
import subagentCostAdvisory from "./subagent-cost-advisory.ts";
import unshippedCostAdvisory from "./unshipped-cost-advisory.ts";
import unusedMcpDisable from "./unused-mcp-disable.ts";
import unusedSkillArchive from "./unused-skill-archive.ts";

export const strategies: StrategyDefinition[] = [
  autoCompactOveruseAdvisory,
  claudeMdBloat,
  modelMixAdvisory,
  noSkillsAdvisory,
  retryStormAdvisory,
  shellOutputVerboseAdvisory,
  subagentCostAdvisory,
  unshippedCostAdvisory,
  unusedMcpDisable,
  unusedSkillArchive,
];

// Sanity: unique IDs.
const seen = new Set<string>();
for (const s of strategies) {
  if (seen.has(s.id)) {
    throw new Error(`duplicate strategy id: ${s.id}`);
  }
  seen.add(s.id);
}
