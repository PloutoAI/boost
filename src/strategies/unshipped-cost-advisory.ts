/**
 * `unshipped-cost-advisory` — flag expensive sessions that produced no
 * git commits. The signal is outcome attribution: tie each session's
 * USD spend to whether any commits landed in the session's working
 * directories during or shortly after the session.
 *
 * Cost-of-correctness vs cost-of-coverage trade-off:
 * - Conservative window expansion (1h before, 24h after) reduces false
 *   negatives (real ship events we'd otherwise miss to a squash-merge
 *   or a delayed push).
 * - Any commit in any branch counts. Session-then-different-branch
 *   workflows are common.
 * - Sessions in non-git cwds → "untrackable" (not "abandoned"). We
 *   never report cost as wasted when we lack evidence.
 *
 * Per-session findings (Finding[]), top 5 by cost. Severity:
 *   high   single session ≥ $50 abandoned
 *   medium single session ≥ $15 abandoned
 *   low    single session ≥ $5 abandoned
 *
 * Advisory only. boost can't make the session ship — the finding
 * forces the user to *look at the receipts*: was this session
 * exploratory and valuable, or was it a wasted afternoon?
 */
import type { Finding } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import { expensiveSessionsLastNDays, type SessionCostBreakdown } from "../summary.ts";
import { commitsInRange } from "../data/git.ts";
import { formatUsd } from "../pricing.ts";
import { HOUR_MS, DAY_MS } from "../time.ts";

const id = "unshipped-cost-advisory";
const version = 1;

const WINDOW_DAYS = 7;
const MIN_DAYS = 7;
/** Don't flag tiny sessions — exploration is cheap and valuable. */
const MIN_SESSION_USD = 5;
/** Cap findings; chronic abandoners shouldn't drown the audit. */
const MAX_FINDINGS = 5;

const strategy: StrategyDefinition = {
  id,
  version,
  category: "trade-offs",
  defaultSeverity: "medium",
  safeToApply: false,

  title: (f) => {
    const sig = f.evidence.signals as { costUsd?: number; cwds?: string[] };
    const usd = formatUsd(sig.costUsd ?? 0);
    const where = (sig.cwds ?? []).map(shortCwd).join(", ") || "session";
    return `${usd} session in ${where} produced no commits`;
  },

  detect: (ctx) => {
    if (ctx.daysOfDataAvailable < MIN_DAYS) return null;

    const sessions = expensiveSessionsLastNDays(ctx.events.db, WINDOW_DAYS, MIN_SESSION_USD);
    if (sessions.length === 0) return null;

    const abandoned: SessionCostBreakdown[] = [];
    for (const s of sessions) {
      if (s.cwds.length === 0) continue; // unattributable, skip
      const sinceIso = new Date(Date.parse(s.firstAtIso) - 1 * HOUR_MS).toISOString();
      const untilIso = new Date(Date.parse(s.lastAtIso) + 1 * DAY_MS).toISOString();

      let shipped = false;
      let trackableCwds = 0;
      for (const cwd of s.cwds) {
        const commits = commitsInRange({ cwd, sinceIso, untilIso });
        if (commits === null) continue; // untrackable cwd
        trackableCwds += 1;
        if (commits.length > 0) {
          shipped = true;
          break;
        }
      }
      // Only treat as abandoned if at least one cwd was a real git repo
      // we could check. All-untrackable sessions stay silent.
      if (!shipped && trackableCwds > 0) abandoned.push(s);
    }

    if (abandoned.length === 0) return null;

    const findings: Finding[] = [];
    for (const s of abandoned.slice(0, MAX_FINDINGS)) {
      findings.push(buildFinding(ctx.now, s));
    }
    return findings;
  },

  explain: (f) => {
    const sig = f.evidence.signals as {
      costUsd?: number;
      cwds?: string[];
      requests?: number;
      durationHours?: number;
      firstAtIso?: string;
      lastAtIso?: string;
    };
    const lines: string[] = [];
    const usd = formatUsd(sig.costUsd ?? 0);
    const where = (sig.cwds ?? []).join(", ") || "(unknown)";
    lines.push(`Session ${f.affectedItems[0]} cost ${usd} but no commits landed in its cwd during or after the session.`);
    lines.push("");
    lines.push(`Project(s): ${where}`);
    lines.push(`Requests:   ${sig.requests ?? 0}`);
    if (sig.firstAtIso && sig.lastAtIso) {
      lines.push(`Window:     ${sig.firstAtIso.slice(0, 16).replace("T", " ")} → ${sig.lastAtIso.slice(0, 16).replace("T", " ")}`);
    }
    if (sig.durationHours !== undefined) {
      lines.push(`Duration:   ~${sig.durationHours.toFixed(1)}h of wall time`);
    }
    lines.push("");
    lines.push("This doesn't mean the session was waste — exploration, planning, and learning are all valid no-commit work. But ${usd} is real money. Worth one of these:");
    lines.push("  • Look at the session — was the goal achievable in the first place?");
    lines.push("  • Was the model right for the task? Could a cheaper model have done the exploration?");
    lines.push("  • Did the work continue in another session that DID ship? If so, this finding is noise.");
    lines.push("");
    lines.push("Boost will never auto-fix this — outcome decisions are yours. The finding exists so you see the receipt.");
    return lines.join("\n").replace(/\$\{usd\}/g, usd);
  },
};

function buildFinding(now: Date, s: SessionCostBreakdown): Finding {
  const durationHours = (Date.parse(s.lastAtIso) - Date.parse(s.firstAtIso)) / HOUR_MS;
  const severity: Finding["severity"] =
    s.costUsd >= 50 ? "high" : s.costUsd >= 15 ? "medium" : "low";
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
        costUsd: Math.round(s.costUsd * 100) / 100,
        cwds: s.cwds,
        requests: s.requests,
        uncachedTokens: s.uncachedTokens,
        durationHours: Math.round(durationHours * 10) / 10,
        firstAtIso: s.firstAtIso,
        lastAtIso: s.lastAtIso,
      },
      humanReadable: `${formatUsd(s.costUsd)} session in ${s.cwds.map(shortCwd).join(", ") || "session"} produced no commits.`,
    },
  };
  finding.title = strategy.title(finding);
  return finding;
}

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

export default strategy;
