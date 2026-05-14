/**
 * `shell-output-verbose-advisory` — flag when Bash tool responses are
 * eating a meaningful slice of weekly uncached spend.
 *
 * Claude's Bash tool returns the raw output of CLI commands. Tools
 * like `git status`, `docker ps`, `cargo test`, `kubectl get pods`
 * print 1–10KB of human-formatted noise per call — help hints,
 * decorative blank lines, status boilerplate — most of which Claude
 * doesn't need but reads as input tokens regardless.
 *
 * boost can't compress shell output itself; that's a runtime concern
 * for a proxy between the shell and Claude. This advisory surfaces
 * the waste class and points at the right layer of tool (e.g. rtk:
 * https://github.com/rtk-ai/rtk).
 *
 * Detection: cluster Bash tool_use events by `bash_command_stem`
 * (first whitespace token of `input.command`), join to tool_result
 * via `tool_use_id` for response size. Only successful responses
 * above MIN_RESPONSE_BYTES count. Flag when:
 *   - aggregate "expensive" Bash response bytes / 4  ≥  MIN_SHARE
 *     of weekly uncached tokens, AND
 *   - at least MIN_EXPENSIVE_CALLS qualifying calls exist.
 *
 * Single aggregate finding; top stems by total bytes shown as evidence.
 * Cold-start gate: ≥7 days of data.
 *
 * Backfill note: `bash_command_stem` is captured at normalize time, so
 * events ingested before the field was added carry `stem = null` and are
 * filtered out by the SQL. On a freshly-upgraded install the advisory
 * therefore "warms up" — it sees only sessions ingested after upgrade
 * and starts firing once enough recent activity has accumulated. To
 * force immediate detection, the user can delete `~/.boost/db.sqlite`
 * to re-ingest the JSONL log from scratch.
 */
import type { Finding } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import { shellOutputBreakdownLastNDays, uncachedTokensLastNDays } from "../summary.ts";
import { formatCompactNumber as fmt } from "../format.ts";

const id = "shell-output-verbose-advisory";
const version = 1;

const WINDOW_DAYS = 7;
const MIN_DAYS = 7;
/** A "long" response — anything below this is noise-free enough to skip. */
const MIN_RESPONSE_BYTES = 2000;
/** Need real frequency, not one giant single output, to flag a behaviour. */
const MIN_EXPENSIVE_CALLS = 5;
/** Below this share, the recommendation isn't worth interrupting on. */
const MIN_SHARE_TO_FLAG = 0.03;
/** Standard heuristic: ~4 bytes per token for English/code mix. */
const BYTES_PER_TOKEN = 4;
const TOP_STEMS = 5;

const strategy: StrategyDefinition = {
  id,
  version,
  category: "trade-offs",
  defaultSeverity: "low",

  title: (f) => {
    const sig = f.evidence.signals as { sharePct?: number; totalCalls?: number };
    const pct = Math.round(sig.sharePct ?? 0);
    const calls = sig.totalCalls ?? 0;
    return `Verbose shell output = ~${pct}% of weekly spend (${calls} calls)`;
  },

  detect: (ctx) => {
    if (ctx.daysOfDataAvailable < MIN_DAYS) return null;

    const breakdown = shellOutputBreakdownLastNDays(ctx.events.db, WINDOW_DAYS, MIN_RESPONSE_BYTES);
    if (breakdown.length === 0) return null;

    const totalCalls = breakdown.reduce((s, b) => s + b.calls, 0);
    if (totalCalls < MIN_EXPENSIVE_CALLS) return null;

    const totalBytes = breakdown.reduce((s, b) => s + b.totalBytes, 0);
    const weeklyUncached = uncachedTokensLastNDays(ctx.events.db, WINDOW_DAYS);
    if (weeklyUncached <= 0) return null;

    const tokensFromShell = totalBytes / BYTES_PER_TOKEN;
    const share = tokensFromShell / weeklyUncached;
    if (share < MIN_SHARE_TO_FLAG) return null;

    const topStems = [...breakdown]
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .slice(0, TOP_STEMS);

    return buildFinding(ctx.now, share, totalBytes, totalCalls, topStems);
  },

  explain: (f) => {
    const sig = f.evidence.signals as {
      sharePct?: number;
      totalBytes?: number;
      totalCalls?: number;
      topStems?: Array<{ stem: string; calls: number; bytes: number }>;
    };
    const pct = Math.round(sig.sharePct ?? 0);
    const lines: string[] = [];
    lines.push(
      `${sig.totalCalls ?? 0} Bash calls returned >${fmt(MIN_RESPONSE_BYTES)} bytes each in the ` +
        `last ${f.evidence.windowDays} days, totalling ~${fmt(sig.totalBytes ?? 0)} bytes ` +
        `(≈${pct}% of weekly uncached spend at ${BYTES_PER_TOKEN} bytes/token).`,
    );
    if (sig.topStems && sig.topStems.length > 0) {
      lines.push("");
      lines.push("Top commands by response size:");
      for (const s of sig.topStems) {
        lines.push(
          `  • ${s.stem.padEnd(12)} ${s.calls.toString().padStart(4)} calls · ${fmt(s.bytes)} bytes`,
        );
      }
    }
    lines.push("");
    lines.push("Each call's verbose output (help hints, decorative blank lines, repeated");
    lines.push("status boilerplate) is read by Claude as input tokens.");
    lines.push("");
    lines.push("boost can't compress this — it's a runtime concern between the shell and");
    lines.push("Claude. Tools that sit in that layer reduce these responses by 60–90%:");
    lines.push("  • rtk — https://github.com/rtk-ai/rtk  (Rust, brew install)");
    lines.push("");
    lines.push("This finding is advisory — boost has no automated fix.");
    return lines.join("\n");
  },
};

type StemBreakdown = { stem: string; calls: number; totalBytes: number };

function buildFinding(
  now: Date,
  share: number,
  totalBytes: number,
  totalCalls: number,
  topStems: StemBreakdown[],
): Finding {
  const sharePct = share * 100;
  const severity: Finding["severity"] = sharePct >= 10 ? "medium" : "low";
  const topPayload = topStems.map((s) => ({ stem: s.stem, calls: s.calls, bytes: s.totalBytes }));
  const finding: Finding = {
    strategyId: id,
    strategyVersion: version,
    category: "trade-offs",
    severity,
    title: "",
    affectedItems: topStems.map((s) => s.stem),
    estimatedTokensSavedPerRequest: 0,
    estimatedPercentOfWeeklyUsage: round1(sharePct),
    evidence: {
      observedAtIso: now.toISOString(),
      windowDays: WINDOW_DAYS,
      signals: {
        sharePct: round1(sharePct),
        totalBytes,
        totalCalls,
        topStems: topPayload,
      },
      humanReadable:
        `${totalCalls} Bash calls returned >${MIN_RESPONSE_BYTES} bytes each, ` +
        `totalling ${fmt(totalBytes)} bytes (≈${Math.round(sharePct)}% of weekly uncached spend).`,
    },
  };
  finding.title = strategy.title(finding);
  return finding;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export default strategy;
