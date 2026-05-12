/**
 * `auto-compact-overuse-advisory` — flag sessions with repeated
 * auto-compacts. Each `auto_compact` event in Claude Code means the
 * context window filled up, Claude Code summarised the history, and
 * the next turn started from a freshly built prefix.
 *
 * The cost is in three places:
 *  1. The compact itself summarises the prior history → tokens spent.
 *  2. The prior turn's cache is discarded → next turn pays full
 *     uncached input.
 *  3. The summary necessarily loses fidelity → more re-asks, more
 *     retries, more drift.
 *
 * One compact is normal in a long session. Three or more in a single
 * session is the smell — the user keeps refilling context after the
 * compact instead of starting a fresh session.
 *
 * Advisory only. boost can't auto-compact for the user — the action
 * is behavioral: `/clear` more, or finish a task per session.
 *
 * Per-session findings (Finding[]), capped at 5, ranked by compact
 * count descending then total pre-compact tokens descending.
 */
import type { Finding } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import {
  sessionCompactBreakdownLastNDays,
  type SessionCompactBreakdown,
} from "../summary.ts";
import { formatCompactNumber as fmt } from "../format.ts";

const id = "auto-compact-overuse-advisory";
const version = 1;

const WINDOW_DAYS = 14;
const MIN_DAYS = 7;
/** Threshold for surfacing — 1 or 2 compacts is normal for long work. */
const MIN_COMPACTS_TO_FLAG = 3;
/** Cap output. */
const MAX_FINDINGS = 5;

const strategy: StrategyDefinition = {
  id,
  version,
  category: "trade-offs",
  defaultSeverity: "low",
  safeToApply: false,

  title: (f) => {
    const sig = f.evidence.signals as { compacts?: number; totalPreTokens?: number };
    const n = sig.compacts ?? 0;
    return `Session auto-compacted ${n}× (${fmt(sig.totalPreTokens ?? 0)} tokens summarised)`;
  },

  detect: (ctx) => {
    if (ctx.daysOfDataAvailable < MIN_DAYS) return null;

    const sessions = sessionCompactBreakdownLastNDays(ctx.events.db, WINDOW_DAYS);
    if (sessions.length === 0) return null;

    const candidates = sessions.filter((s) => s.compactCount >= MIN_COMPACTS_TO_FLAG);
    if (candidates.length === 0) return null;

    const findings: Finding[] = [];
    for (const s of candidates.slice(0, MAX_FINDINGS)) {
      findings.push(buildFinding(ctx.now, s));
    }
    return findings;
  },

  explain: (f) => {
    const sig = f.evidence.signals as {
      compacts?: number;
      totalPreTokens?: number;
      firstIso?: string;
      lastIso?: string;
    };
    const n = sig.compacts ?? 0;
    const lines: string[] = [];
    lines.push(
      `Session ${f.affectedItems[0]} auto-compacted ${n} times in the last ${f.evidence.windowDays} days, ` +
        `summarising ${fmt(sig.totalPreTokens ?? 0)} tokens of context.`,
    );
    if (sig.firstIso && sig.lastIso) {
      lines.push(`First compact: ${sig.firstIso.replace("T", " ").slice(0, 19)}.`);
      lines.push(`Last compact:  ${sig.lastIso.replace("T", " ").slice(0, 19)}.`);
    }
    lines.push("");
    lines.push("Each compact:");
    lines.push("  • Pays tokens to summarise the prior history.");
    lines.push("  • Discards the prior turn's cache — next turn rebuilds from scratch.");
    lines.push("  • Loses fidelity — more re-asks, more drift, more retries.");
    lines.push("");
    lines.push("If you see ≥3 compacts in one session, you're probably:");
    lines.push("  • Treating one Claude Code session as a multi-day workspace. /clear between tasks.");
    lines.push("  • Pulling in oversized files repeatedly. Use the dispatch_agent for one-shot reads.");
    lines.push("  • Letting Read calls re-fetch the same files. Pin the relevant ones early.");
    lines.push("");
    lines.push("This finding is advisory — boost has no automated fix. The behavior is yours to change.");
    return lines.join("\n");
  },
};

function buildFinding(now: Date, s: SessionCompactBreakdown): Finding {
  const severity: Finding["severity"] =
    s.compactCount >= 8 ? "high" : s.compactCount >= 5 ? "medium" : "low";
  const finding: Finding = {
    strategyId: id,
    strategyVersion: version,
    category: "trade-offs",
    severity,
    safeToApply: false,
    title: "",
    affectedItems: [s.sessionId],
    estimatedTokensSavedPerRequest: 0,
    estimatedPercentOfWeeklyUsage: null,
    evidence: {
      observedAtIso: now.toISOString(),
      windowDays: WINDOW_DAYS,
      signals: {
        compacts: s.compactCount,
        totalPreTokens: s.totalPreTokens,
        firstIso: s.firstCompactIso,
        lastIso: s.lastCompactIso,
      },
      humanReadable: `Session ${s.sessionId.slice(0, 8)}...: ${s.compactCount} auto-compacts, ${fmt(s.totalPreTokens)} tokens summarised.`,
    },
  };
  finding.title = strategy.title(finding);
  return finding;
}

export default strategy;
