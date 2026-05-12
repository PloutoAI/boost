/**
 * Chat-friendly markdown output mode for `boost --chat`.
 *
 * Purpose: when boost is invoked from a Claude Code slash command, the
 * plugin shouldn't have to author ad-hoc Python (or other) parsing
 * scripts to format the output for the user. The binary owns the
 * formatting end-to-end; the plugin shells out, captures stdout, drops
 * it into the conversation unchanged.
 *
 * Designed to be terse — surfaces what the user can act on (findings,
 * next-step slash commands) and skips the activity panel + observed
 * blocks, which the JSON / plain text outputs cover.
 */
import type { JsonOutput } from "./json.ts";
import { formatUsd } from "../pricing.ts";
import type { Finding } from "../types.ts";

export function renderChat(out: JsonOutput): string {
  const s = out.summary;
  const total = s.cost_last_7_days_usd;
  const uncached = s.uncached_cost_last_7_days_usd;
  const lines: string[] = [];

  lines.push(`# boost — last 7 days`);
  lines.push("");
  lines.push(headlineSpendLine(total, uncached, s.sessions_last_7_days, s.cache_hit_rate_last_7_days));

  const p = s.rate_limit_pressure;
  if (p.level !== "low") {
    const drivers = p.drivers.slice(0, 2).join("; ");
    lines.push(`Rate-limit pressure: **${p.level}** (${p.score}/100)${drivers ? ` — ${drivers}` : ""}`);
  }
  lines.push("");

  const cw = out.findings.clear_wins;
  const to = out.findings.trade_offs;
  if (cw.length > 0) {
    lines.push("## Clear wins");
    lines.push("");
    for (const f of cw) lines.push(...findingLines(f, uncached));
    lines.push("");
  }
  if (to.length > 0) {
    lines.push("## Trade-offs (advisory)");
    lines.push("");
    for (const f of to) lines.push(...findingLines(f, uncached));
    lines.push("");
  }
  if (cw.length === 0 && to.length === 0) {
    lines.push("No findings to act on right now.");
    lines.push("");
  }

  lines.push("More: `/boost:boost yield` (outcome attribution) · `/boost:boost reskill` (project skills).");
  return lines.join("\n") + "\n";
}

function headlineSpendLine(
  total: number | null,
  uncached: number | null,
  sessions: number,
  hitRate: number,
): string {
  const hitPct = Math.round(hitRate * 100);
  if (total === null || uncached === null) {
    return `Spend: — · ${sessions} sessions · ${hitPct}% cache hit`;
  }
  const cacheReads = Math.max(0, total - uncached);
  return `Spend: **${formatUsd(total)}** total · ${formatUsd(uncached)} uncached + ${formatUsd(cacheReads)} cache reads · ${sessions} sessions · ${hitPct}% cache hit`;
}

function findingLines(f: Finding, uncachedCost: number | null): string[] {
  const pct = f.estimatedPercentOfWeeklyUsage;
  const dollarHint =
    uncachedCost !== null && pct !== null && pct > 0
      ? ` · ≈${formatUsd((uncachedCost * pct) / 100)}/wk saved`
      : "";
  const out: string[] = [];
  out.push(`- **[${f.severity.toUpperCase()}]** ${f.title}${dollarHint}`);
  if (f.fixes && f.fixes.length > 0) {
    out.push(`  → \`/boost:boost apply ${f.strategyId}\``);
  }
  return out;
}
