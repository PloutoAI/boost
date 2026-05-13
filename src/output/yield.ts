/**
 * `boost outcomes` (alias: `boost yield`) — outcome attribution. Where
 * `unshipped-cost-advisory` flags specific suspicious sessions,
 * `yield` answers the broader question: of every dollar I spent on
 * Claude Code this week, how much produced a commit?
 *
 * Three buckets:
 *   - shipped       — at least one cwd had a commit in the session window
 *   - abandoned     — every checkable cwd was a real git repo with no commits
 *   - unverifiable  — every cwd was either deleted, not a git repo, or
 *                     otherwise opaque to git log
 *
 * Important: `unverifiable` is not "abandoned." It's the integrity gap
 * boost surfaces honestly rather than hiding. A user looking at $751
 * of unverifiable spend can decide for themselves whether to start
 * tracking those projects in git.
 */
import type { Database as BunDatabase } from "bun:sqlite";
import { expensiveSessionsLastNDays, type SessionCostBreakdown } from "../summary.ts";
import { commitsInRange } from "../data/git.ts";
import { formatUsd, PRICING_SNAPSHOT_DATE } from "../pricing.ts";
import { HOUR_MS, DAY_MS } from "../time.ts";

export type SessionClassification = "shipped" | "abandoned" | "unverifiable";

export type ClassifiedSession = {
  session: SessionCostBreakdown;
  classification: SessionClassification;
};

export type YieldReport = {
  windowDays: number;
  minCostUsd: number;
  totalSessionsConsidered: number;
  shipped: { count: number; costUsd: number; sessions: SessionCostBreakdown[] };
  abandoned: { count: number; costUsd: number; sessions: SessionCostBreakdown[] };
  unverifiable: { count: number; costUsd: number; sessions: SessionCostBreakdown[] };
  pricingSnapshotDate: string;
};

const SHIPPED_GRACE_BEFORE_MS = 1 * HOUR_MS;
const SHIPPED_GRACE_AFTER_MS = 1 * DAY_MS;

/**
 * Classify each session into shipped / abandoned / unverifiable based
 * on git history in its cwds. Shared by the yield view and the
 * unshipped-cost detector so they can't drift.
 */
export function classifySessions(sessions: SessionCostBreakdown[]): ClassifiedSession[] {
  const out: ClassifiedSession[] = [];
  for (const s of sessions) {
    out.push({ session: s, classification: classifyOne(s) });
  }
  return out;
}

function classifyOne(s: SessionCostBreakdown): SessionClassification {
  if (s.cwds.length === 0) return "unverifiable";
  const sinceIso = new Date(Date.parse(s.firstAtIso) - SHIPPED_GRACE_BEFORE_MS).toISOString();
  const untilIso = new Date(Date.parse(s.lastAtIso) + SHIPPED_GRACE_AFTER_MS).toISOString();

  let trackable = 0;
  for (const cwd of s.cwds) {
    const commits = commitsInRange({ cwd, sinceIso, untilIso });
    if (commits === null) continue;
    trackable += 1;
    if (commits.length > 0) return "shipped";
  }
  return trackable > 0 ? "abandoned" : "unverifiable";
}

export function buildYieldReport(
  db: BunDatabase,
  windowDays: number = 7,
  minCostUsd: number = 5,
): YieldReport {
  const sessions = expensiveSessionsLastNDays(db, windowDays, minCostUsd);
  const classified = classifySessions(sessions);
  const r: YieldReport = {
    windowDays,
    minCostUsd,
    totalSessionsConsidered: sessions.length,
    shipped: { count: 0, costUsd: 0, sessions: [] },
    abandoned: { count: 0, costUsd: 0, sessions: [] },
    unverifiable: { count: 0, costUsd: 0, sessions: [] },
    pricingSnapshotDate: PRICING_SNAPSHOT_DATE,
  };
  for (const c of classified) {
    const bucket = r[c.classification];
    bucket.count += 1;
    bucket.costUsd += c.session.costUsd;
    bucket.sessions.push(c.session);
  }
  // Sort each bucket descending by cost for nice render.
  r.shipped.sessions.sort((a, b) => b.costUsd - a.costUsd);
  r.abandoned.sessions.sort((a, b) => b.costUsd - a.costUsd);
  r.unverifiable.sessions.sort((a, b) => b.costUsd - a.costUsd);
  return r;
}

export function renderYieldReport(r: YieldReport): string {
  const lines: string[] = [];
  lines.push(`boost outcomes — last ${r.windowDays} days`);
  lines.push("");
  if (r.totalSessionsConsidered === 0) {
    lines.push(`No sessions ≥ ${formatUsd(r.minCostUsd)} in window. Nothing to attribute.`);
    return lines.join("\n") + "\n";
  }
  const total = r.shipped.costUsd + r.abandoned.costUsd + r.unverifiable.costUsd;
  const pct = (n: number): string => (total > 0 ? `${Math.round((n / total) * 100)}%`.padStart(4) : " — ");

  lines.push(`  Tracked sessions ≥ ${formatUsd(r.minCostUsd)}: ${r.totalSessionsConsidered}`);
  lines.push("");
  lines.push(`  ✓ Shipped       ${formatUsd(r.shipped.costUsd).padStart(7)}  ${pct(r.shipped.costUsd)}  (${r.shipped.count} session${r.shipped.count === 1 ? "" : "s"})`);
  for (const s of r.shipped.sessions.slice(0, 5)) {
    lines.push(`      ${shortCwd(s.cwds[0] ?? "—").padEnd(34)} ${formatUsd(s.costUsd).padStart(8)}`);
  }
  lines.push("");
  lines.push(`  ✗ Abandoned     ${formatUsd(r.abandoned.costUsd).padStart(7)}  ${pct(r.abandoned.costUsd)}  (${r.abandoned.count} session${r.abandoned.count === 1 ? "" : "s"})`);
  for (const s of r.abandoned.sessions.slice(0, 5)) {
    lines.push(`      ${shortCwd(s.cwds[0] ?? "—").padEnd(34)} ${formatUsd(s.costUsd).padStart(8)}`);
  }
  lines.push("");
  lines.push(`  ? Unverifiable  ${formatUsd(r.unverifiable.costUsd).padStart(7)}  ${pct(r.unverifiable.costUsd)}  (${r.unverifiable.count} session${r.unverifiable.count === 1 ? "" : "s"} — non-git or relocated cwd)`);
  for (const s of r.unverifiable.sessions.slice(0, 5)) {
    lines.push(`      ${shortCwd(s.cwds[0] ?? "—").padEnd(34)} ${formatUsd(s.costUsd).padStart(8)}`);
  }
  lines.push("");
  lines.push(`Pricing snapshot: ${r.pricingSnapshotDate} (bundled, offline).`);
  return lines.join("\n") + "\n";
}

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}
