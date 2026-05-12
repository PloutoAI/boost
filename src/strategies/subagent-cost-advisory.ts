/**
 * `subagent-cost-advisory` — flag sessions where Task() subagent
 * (sidechain) spend is a material slice of the session's uncached
 * tokens. The signal is `is_sidechain = true` on api_request rows;
 * the v2 normalizer captures it from the line-level field.
 *
 * Advisory only. boost can't reduce subagent cost automatically —
 * the user decides when to spawn a Task() and on which model.
 * Surfacing the share lets the user:
 *   - notice that subagents are eating into their budget;
 *   - reach for cheaper models inside subagents (Haiku for sweeps);
 *   - recognise the "every question becomes Task()" anti-pattern.
 *
 * Per-session findings — first consumer of the runner's array-return
 * support that *expects* multiple findings per run. Top 5 sessions
 * ranked by absolute sidechain tokens.
 *
 * Cold-start gate: ≥ 7 days of data. Window: 14 days. Sessions under
 * a 100k-token floor are dropped to avoid flagging trivial usage.
 */
import type { Finding } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import {
  sessionSidechainBreakdownLastNDays,
  type SessionSidechainBreakdown,
} from "../summary.ts";
import { formatCompactNumber as fmt } from "../format.ts";

const id = "subagent-cost-advisory";
const version = 1;

const WINDOW_DAYS = 14;
const MIN_DAYS = 7;
/** Don't flag tiny sessions; the share is too noisy to be actionable. */
const MIN_SESSION_UNCACHED = 100_000;
/** Below this share the signal is not worth interrupting on. */
const MIN_SHARE_TO_FLAG = 0.15;
/** Cap output so a Task()-heavy user doesn't drown the audit. */
const MAX_FINDINGS = 5;

const strategy: StrategyDefinition = {
  id,
  version,
  category: "trade-offs",
  defaultSeverity: "medium",

  title: (f) => {
    const sig = f.evidence.signals as { sharePct?: number; sidechainTokens?: number };
    const pct = sig.sharePct ?? 0;
    const tokens = sig.sidechainTokens ?? 0;
    return `Subagents = ${Math.round(pct)}% of session uncached (${fmt(tokens)} tokens)`;
  },

  detect: (ctx) => {
    if (ctx.daysOfDataAvailable < MIN_DAYS) return null;

    const sessions = sessionSidechainBreakdownLastNDays(ctx.events.db, WINDOW_DAYS);
    if (sessions.length === 0) return null;

    const candidates = sessions.filter((s) => {
      if (s.totalUncachedTokens < MIN_SESSION_UNCACHED) return false;
      const share = s.sidechainUncachedTokens / s.totalUncachedTokens;
      return share >= MIN_SHARE_TO_FLAG;
    });
    if (candidates.length === 0) return null;

    const findings: Finding[] = [];
    for (const s of candidates.slice(0, MAX_FINDINGS)) {
      findings.push(buildFinding(ctx.now, s));
    }
    return findings;
  },

  explain: (f) => {
    const sig = f.evidence.signals as {
      sharePct?: number;
      sidechainTokens?: number;
      totalTokens?: number;
      sidechainRequests?: number;
      totalRequests?: number;
    };
    const lines: string[] = [];
    lines.push(
      `Session ${f.affectedItems[0]} spent ${fmt(sig.sidechainTokens ?? 0)} of ${fmt(sig.totalTokens ?? 0)} ` +
        `uncached tokens inside Task() subagents — ${Math.round(sig.sharePct ?? 0)}% of the session's cost.`,
    );
    lines.push("");
    lines.push(
      `Subagent requests: ${sig.sidechainRequests ?? 0} of ${sig.totalRequests ?? 0} total.`,
    );
    lines.push("");
    lines.push("Subagent cost is hard to feel because each Task() looks cheap in the moment.");
    lines.push("In aggregate it adds up — especially if the same model runs in the subagent as the main loop.");
    lines.push("");
    lines.push("If subagent spend feels high:");
    lines.push("  • Use Haiku or Sonnet inside Task() for searches, file walks, summarization.");
    lines.push("  • Reserve Opus subagents for genuine architectural delegations.");
    lines.push("  • Inline simple work in the main loop rather than spinning a subagent.");
    lines.push("");
    lines.push("This finding is advisory — boost has no automated fix.");
    return lines.join("\n");
  },
};

function buildFinding(now: Date, s: SessionSidechainBreakdown): Finding {
  const share = s.sidechainUncachedTokens / Math.max(1, s.totalUncachedTokens);
  const severity: Finding["severity"] =
    share >= 0.6 ? "high" : share >= 0.3 ? "medium" : "low";
  const finding: Finding = {
    strategyId: id,
    strategyVersion: version,
    category: "trade-offs",
    severity,
    title: "",
    affectedItems: [s.sessionId],
    estimatedTokensSavedPerRequest: 0,
    estimatedPercentOfWeeklyUsage: null,
    evidence: {
      observedAtIso: now.toISOString(),
      windowDays: WINDOW_DAYS,
      signals: {
        sharePct: round1(share * 100),
        sidechainTokens: s.sidechainUncachedTokens,
        totalTokens: s.totalUncachedTokens,
        sidechainRequests: s.sidechainRequests,
        totalRequests: s.totalRequests,
      },
      humanReadable: `Session ${s.sessionId.slice(0, 8)}...: subagents = ${Math.round(share * 100)}% of uncached spend (${fmt(s.sidechainUncachedTokens)} of ${fmt(s.totalUncachedTokens)} tokens).`,
    },
  };
  finding.title = strategy.title(finding);
  return finding;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export default strategy;
