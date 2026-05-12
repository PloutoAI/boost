/**
 * Stable two-pass sort for findings:
 *
 *   Pass 1: clear-wins first, trade-offs second.
 *   Pass 2: within a category, severity desc, then estimated weekly % desc,
 *           with `null` percent values sorted after numeric ones.
 */
import type { Finding } from "./types.ts";

const SEVERITY_RANK: Record<Finding["severity"], number> = { high: 3, medium: 2, low: 1 };

export function rankFindings(findings: Finding[]): Finding[] {
  const annotated = findings.map((f, i) => ({ f, i }));
  annotated.sort((a, b) => {
    if (a.f.category !== b.f.category) return a.f.category === "clear-wins" ? -1 : 1;
    const sevDelta = SEVERITY_RANK[b.f.severity] - SEVERITY_RANK[a.f.severity];
    if (sevDelta !== 0) return sevDelta;

    const aPct = a.f.estimatedPercentOfWeeklyUsage;
    const bPct = b.f.estimatedPercentOfWeeklyUsage;
    if (aPct === null && bPct === null) return a.i - b.i;
    if (aPct === null) return 1;
    if (bPct === null) return -1;
    if (aPct !== bPct) return bPct - aPct;
    return a.i - b.i;
  });
  return annotated.map((x) => x.f);
}

/** Total predicted savings if every clear-win were applied. */
export function totalClearWinsSavings(findings: Finding[]): number {
  return findings
    .filter((f) => f.category === "clear-wins" && f.estimatedPercentOfWeeklyUsage !== null)
    .reduce((sum, f) => sum + (f.estimatedPercentOfWeeklyUsage ?? 0), 0);
}
