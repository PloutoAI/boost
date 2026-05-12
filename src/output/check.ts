/**
 * `boost --check` — compact, scriptable, non-interactive output.
 *
 * Exit codes:
 *   0  no findings ≥ medium (or no data yet to evaluate)
 *   1  one or more findings at medium- or high-severity
 *   3  no Claude Code data yet (first-run / not enough sessions to evaluate)
 *
 * Distinguishing "no data" (3) from "good shape" (0) lets scripted
 * callers see the difference without parsing prose — e.g. a personal
 * pre-push hook can ignore exit 3 (fresh machine) but treat exit 1 as
 * blocking. Note: boost reads ~/.claude/projects/*.jsonl, which only
 * exists on a developer's local machine. It's not a CI primitive —
 * CI runners don't have the data. The intended consumers are local
 * shell hooks (pre-push, cron) and humans who just want a one-line
 * status instead of the TUI.
 *
 * One threshold (medium-or-above), no knobs — the severity bands are
 * already detector-defined, layering a configurable cutoff on top adds
 * surface without sharpening the signal. Callers wanting finer gates
 * can use `boost --json | jq`.
 */
import type { Finding } from "../types.ts";
import type { Summary } from "../summary.ts";
import { formatUsd } from "../pricing.ts";

export type CheckOutput = {
  text: string;
  exitCode: 0 | 1 | 3;
  /** Histogram of severity counts; useful for callers wanting it without re-tallying. */
  counts: { high: number; medium: number; low: number };
};

export function buildCheck(findings: Finding[], summary: Summary): CheckOutput {
  const counts = histogram(findings);
  const totalTokens =
    summary.uncached_tokens_last_7_days + summary.cache_read_tokens_last_7_days;
  if (summary.sessions_last_7_days === 0 && totalTokens === 0) {
    return {
      text:
        "boost: no Claude Code data found yet.\n" +
        "Run a few Claude Code sessions, then re-run `boost` to see what to optimize.\n",
      exitCode: 3,
      counts,
    };
  }
  const costLabel =
    summary.cost_last_7_days_usd !== null ? ` (${formatUsd(summary.cost_last_7_days_usd)} last 7d)` : "";

  if (findings.length === 0) {
    return {
      text: `✓ no findings — your setup is in good shape.${costLabel}\n`,
      exitCode: 0,
      counts,
    };
  }
  const blocking = findings.filter((f) => f.severity !== "low");
  const tripped = blocking.length > 0;

  const lines: string[] = [];
  lines.push(`${tripped ? "✗" : "•"} ${findings.length} issue${findings.length === 1 ? "" : "s"} found${costLabel}:`);
  lines.push(`  ${counts.high} high · ${counts.medium} medium · ${counts.low} low`);
  for (const f of findings) {
    lines.push(`  • ${f.title} [${f.severity}]`);
  }
  lines.push("");
  lines.push(`Run "boost" to review and apply fixes.`);
  return {
    text: lines.join("\n") + "\n",
    exitCode: tripped ? 1 : 0,
    counts,
  };
}

function histogram(findings: Finding[]): { high: number; medium: number; low: number } {
  const c = { high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity] += 1;
  return c;
}
