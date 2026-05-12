/**
 * `model-mix-advisory` — surface per-model uncached-token shares over the
 * last 7 days. When one model dominates (default ≥ 80% of uncached spend
 * AND total spend is meaningful), recommend the standard escalation
 * strategy: Haiku for data-gathering, Sonnet for most coding, Opus only
 * when cheaper models fail.
 *
 * Advisory only — no automated fix. The user picks model per-request via
 * Claude Code's UI; boost can't safely rewrite it. We surface the data.
 *
 * Cold-start gate: ≥ 7 days of data (lower than other detectors because
 * model spend is observable from a single week).
 */
import type { Finding } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import { isCheapModel, modelUsageLastNDays, uncachedTokensLastNDays } from "../summary.ts";

const id = "model-mix-advisory";
const version = 1;
const WINDOW_DAYS = 7;
const MIN_DAYS = 7;
const DOMINANT_THRESHOLD = 0.8;
const MIN_UNCACHED_TOKENS = 100_000;

const strategy: StrategyDefinition = {
  id,
  version,
  category: "trade-offs",
  defaultSeverity: "medium",

  title: (f) => {
    const sig = f.evidence.signals as { dominantModel?: string; dominantSharePct?: number };
    if (sig.dominantModel && typeof sig.dominantSharePct === "number") {
      return `${sig.dominantModel} accounts for ${Math.round(sig.dominantSharePct)}% of last-7-day uncached spend`;
    }
    return "Model mix breakdown";
  },

  detect: (ctx) => {
    if (ctx.daysOfDataAvailable < MIN_DAYS) return null;

    const usage = modelUsageLastNDays(ctx.events.db, WINDOW_DAYS);
    if (usage.length === 0) return null;

    const totalUncached = uncachedTokensLastNDays(ctx.events.db, WINDOW_DAYS);
    if (totalUncached < MIN_UNCACHED_TOKENS) return null;

    // Don't flag if the user is already using a multi-model mix.
    const dominant = usage[0]!;
    const share = dominant.uncachedTokens / totalUncached;
    if (share < DOMINANT_THRESHOLD) return null;

    // Don't pester users who are already on the cheaper models.
    if (isCheapModel(dominant.model)) return null;

    const severity: Finding["severity"] = share >= 0.95 ? "high" : "medium";
    const breakdown = usage.map((u) => ({
      model: u.model,
      uncached_tokens: u.uncachedTokens,
      uncached_share: round3(totalUncached === 0 ? 0 : u.uncachedTokens / totalUncached),
      cache_read_tokens: u.cacheReadTokens,
      requests: u.requests,
    }));

    const finding: Finding = {
      strategyId: id,
      strategyVersion: version,
      category: "trade-offs",
      severity,
      title: "",
      affectedItems: [dominant.model],
      // Conservative point estimate: assume we shave 60% if half of the
      // dominant-model turns shifted to a model 5× cheaper. Rounded for
      // display only; not used for ranking precision.
      estimatedTokensSavedPerRequest: Math.round((dominant.uncachedTokens * 0.6) / Math.max(1, dominant.requests)),
      // Estimated weekly % savings: half the dominant share × 60% effective discount.
      estimatedPercentOfWeeklyUsage: clampPct((share * 100) * 0.5 * 0.6),
      evidence: {
        observedAtIso: ctx.now.toISOString(),
        windowDays: WINDOW_DAYS,
        signals: {
          dominantModel: dominant.model,
          dominantSharePct: round1(share * 100),
          totalUncachedTokens: totalUncached,
          breakdown,
        },
        humanReadable: `${dominant.model} = ${Math.round(share * 100)}% of uncached spend; consider Haiku/Sonnet for non-synthesis turns.`,
      },
      // No fixes — advisory only. The user picks model per-request via Claude Code's UI.
    };
    finding.title = strategy.title(finding);
    return finding;
  },

  explain: (f) => {
    const sig = f.evidence.signals as {
      dominantModel?: string;
      dominantSharePct?: number;
      breakdown?: { model: string; uncached_tokens: number; uncached_share: number; requests: number }[];
    };
    const lines: string[] = [];
    if (sig.dominantModel && typeof sig.dominantSharePct === "number") {
      lines.push(
        `${sig.dominantModel} accounts for ${Math.round(sig.dominantSharePct)}% of your last-7-day uncached token spend.`,
      );
    }
    lines.push("");
    lines.push("Per-model breakdown:");
    for (const b of sig.breakdown ?? []) {
      lines.push(
        `  ${b.model.padEnd(36).slice(0, 36)} ${(b.uncached_tokens / 1_000).toFixed(0).padStart(7)}k tokens · ${b.requests.toString().padStart(4)} requests · ${(b.uncached_share * 100).toFixed(0).padStart(3)}%`,
      );
    }
    lines.push("");
    lines.push("Recommended escalation:");
    lines.push("  • Haiku — data-gathering, file reads, counting, summarization (~5× cheaper)");
    lines.push("  • Sonnet — most coding, writing, judgment");
    lines.push("  • Opus — architecture, complex debugging, final synthesis");
    lines.push("");
    lines.push("Default extended-thinking OFF; toggle on per-message when reasoning genuinely matters.");
    lines.push("");
    lines.push("This finding is advisory — boost has no automated fix. The model is picked per-request in Claude Code's UI.");
    return lines.join("\n");
  },
};

function clampPct(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(99.9, Math.round(n * 10) / 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export default strategy;
