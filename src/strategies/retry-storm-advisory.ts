/**
 * `retry-storm-advisory` — flag sessions where Claude Code retried API
 * calls in tight clusters. Retry storms usually mean one of three things:
 *
 *  1. Anthropic-side overload — peak hours, model launches, throttled tier.
 *  2. Long extended-thinking turns that timed out.
 *  3. Very-large context turns hitting per-tier throughput caps.
 *
 * None of these are fixable by boost. The value of surfacing them is
 * letting the user *see* that retries are eating their wall-clock and
 * adapt (off-peak work, smaller context, thinking off, model swap).
 *
 * Per-session findings. One Finding per noisy session, capped at 5
 * (the noisiest sessions ranked first by total retry wait). First
 * consumer of the runner's array-return support.
 *
 * Data dependency: the v2 normalizer's `api_error` rows. Sessions that
 * predate the v2 ingest won't have these events and won't trigger.
 */
import type { Finding } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import { apiErrorsLastNDays } from "../summary.ts";
import { numOr } from "../data/jsonl-payload.ts";

const id = "retry-storm-advisory";
const version = 1;

const WINDOW_DAYS = 14;
const MIN_DAYS = 7;
/** Errors within this window of the previous error count as the same cluster. */
const CLUSTER_GAP_MS = 60_000;
/** A cluster needs at least this many retries to qualify as a "storm". */
const MIN_CLUSTER_SIZE = 3;
/** Cap output so a chronically-overloaded user doesn't drown the audit. */
const MAX_FINDINGS = 5;

type Retry = {
  sessionId: string;
  timestampMs: number;
  retryAttempt: number;
  maxRetries: number;
  retryInMs: number;
};

type Cluster = {
  sessionId: string;
  startMs: number;
  endMs: number;
  count: number;
  maxAttempt: number;
  hitMaxRetries: boolean;
  totalRetryWaitMs: number;
};

const strategy: StrategyDefinition = {
  id,
  version,
  category: "trade-offs",
  defaultSeverity: "low",
  safeToApply: false,

  title: (f) => {
    const sig = f.evidence.signals as { storms?: number; hitMaxRetries?: boolean };
    const n = sig.storms ?? 0;
    const noun = n === 1 ? "storm" : "storms";
    if (sig.hitMaxRetries) return `Session hit retry cap during ${n} retry ${noun}`;
    return `${n} retry ${noun} in session`;
  },

  detect: (ctx) => {
    if (ctx.daysOfDataAvailable < MIN_DAYS) return null;

    const rows = apiErrorsLastNDays(ctx.events.db, WINDOW_DAYS);
    if (rows.length === 0) return null;

    const errors: Retry[] = [];
    for (const r of rows) {
      let payload: { retry_attempt?: unknown; max_retries?: unknown; retry_in_ms?: unknown };
      try {
        payload = JSON.parse(r.payloadJson);
      } catch {
        continue;
      }
      errors.push({
        sessionId: r.sessionId,
        timestampMs: r.timestampMs,
        retryAttempt: numOr(payload.retry_attempt, 0),
        maxRetries: numOr(payload.max_retries, 0),
        retryInMs: numOr(payload.retry_in_ms, 0),
      });
    }

    if (errors.length === 0) return null;

    // Single pass: ordered by (session, time), so a cluster ends when
    // either the session changes or the gap exceeds CLUSTER_GAP_MS.
    const clusters: Cluster[] = [];
    let current: Cluster | null = null;
    for (const e of errors) {
      const sameSession = current !== null && current.sessionId === e.sessionId;
      const withinGap = current !== null && e.timestampMs - current.endMs <= CLUSTER_GAP_MS;
      if (current && sameSession && withinGap) {
        current.endMs = e.timestampMs;
        current.count += 1;
        current.maxAttempt = Math.max(current.maxAttempt, e.retryAttempt);
        current.hitMaxRetries =
          current.hitMaxRetries || (e.maxRetries > 0 && e.retryAttempt >= e.maxRetries);
        current.totalRetryWaitMs += e.retryInMs;
      } else {
        if (current) clusters.push(current);
        current = {
          sessionId: e.sessionId,
          startMs: e.timestampMs,
          endMs: e.timestampMs,
          count: 1,
          maxAttempt: e.retryAttempt,
          hitMaxRetries: e.maxRetries > 0 && e.retryAttempt >= e.maxRetries,
          totalRetryWaitMs: e.retryInMs,
        };
      }
    }
    if (current) clusters.push(current);

    const storms = clusters.filter((c) => c.count >= MIN_CLUSTER_SIZE);
    if (storms.length === 0) return null;

    // Group storms by session — one finding per session.
    const bySession = new Map<string, Cluster[]>();
    for (const c of storms) {
      const arr = bySession.get(c.sessionId) ?? [];
      arr.push(c);
      bySession.set(c.sessionId, arr);
    }

    const sessionsSorted = Array.from(bySession.entries()).sort((a, b) => {
      const at = totalWait(a[1]);
      const bt = totalWait(b[1]);
      if (bt !== at) return bt - at;
      return b[1].length - a[1].length;
    });

    const findings: Finding[] = [];
    for (const [sessionId, sessionStorms] of sessionsSorted.slice(0, MAX_FINDINGS)) {
      const totalRetries = sessionStorms.reduce((n, c) => n + c.count, 0);
      const totalWaitMs = totalWait(sessionStorms);
      const maxAttemptSeen = sessionStorms.reduce((n, c) => Math.max(n, c.maxAttempt), 0);
      const hitMaxRetries = sessionStorms.some((c) => c.hitMaxRetries);

      const severity: Finding["severity"] = hitMaxRetries
        ? "high"
        : sessionStorms.length >= 3 || totalWaitMs >= 60_000
          ? "medium"
          : "low";

      const finding: Finding = {
        strategyId: id,
        strategyVersion: version,
        category: "trade-offs",
        severity,
        safeToApply: false,
        title: "",
        affectedItems: [sessionId],
        // Retries don't bill tokens — they bill wall-clock. Keep token
        // savings at 0 so the ranker doesn't promote this past clear-wins.
        estimatedTokensSavedPerRequest: 0,
        estimatedPercentOfWeeklyUsage: null,
        evidence: {
          observedAtIso: ctx.now.toISOString(),
          windowDays: WINDOW_DAYS,
          signals: {
            storms: sessionStorms.length,
            totalRetries,
            totalRetryWaitMs: Math.round(totalWaitMs),
            maxAttemptSeen,
            hitMaxRetries,
            clusters: sessionStorms.map((c) => ({
              start_iso: new Date(c.startMs).toISOString(),
              end_iso: new Date(c.endMs).toISOString(),
              retries: c.count,
              max_attempt: c.maxAttempt,
              hit_max: c.hitMaxRetries,
              wait_ms: Math.round(c.totalRetryWaitMs),
            })),
          },
          humanReadable: `Session ${sessionId.slice(0, 8)}... saw ${sessionStorms.length} retry storm${
            sessionStorms.length === 1 ? "" : "s"
          } (${totalRetries} retries, ${Math.round(totalWaitMs / 1000)}s waiting).`,
        },
      };
      finding.title = strategy.title(finding);
      findings.push(finding);
    }

    return findings;
  },

  explain: (f) => {
    const sig = f.evidence.signals as {
      storms?: number;
      totalRetries?: number;
      totalRetryWaitMs?: number;
      maxAttemptSeen?: number;
      hitMaxRetries?: boolean;
      clusters?: Array<{
        start_iso: string;
        end_iso: string;
        retries: number;
        max_attempt: number;
        hit_max: boolean;
        wait_ms: number;
      }>;
    };
    const lines: string[] = [];
    const stormCount = sig.storms ?? 0;
    lines.push(
      `Session ${f.affectedItems[0]} hit ${stormCount} retry storm${
        stormCount === 1 ? "" : "s"
      } in the last ${f.evidence.windowDays} days.`,
    );
    lines.push("");
    lines.push(
      `Total: ${sig.totalRetries ?? 0} retries, ${Math.round((sig.totalRetryWaitMs ?? 0) / 1000)}s of back-off wait.`,
    );
    if (sig.hitMaxRetries) {
      lines.push("");
      lines.push(
        `At least one storm hit the retry cap (max attempt = ${sig.maxAttemptSeen ?? "?"}). That request likely failed.`,
      );
    }
    lines.push("");
    lines.push("Clusters:");
    for (const c of sig.clusters ?? []) {
      const start = c.start_iso.replace("T", " ").replace(/\..*$/, "");
      lines.push(
        `  ${start}  ${String(c.retries).padStart(2)} retries  (max attempt ${c.max_attempt}, ${(c.wait_ms / 1000).toFixed(0)}s wait${c.hit_max ? ", hit cap" : ""})`,
      );
    }
    lines.push("");
    lines.push("Likely causes, ordered by how often they're the answer:");
    lines.push("  1. Anthropic-side overload (peak hours / model launches). Off-peak or model swap.");
    lines.push("  2. Long extended-thinking turns timing out. Keep thinking off by default.");
    lines.push("  3. Oversized context hitting per-tier throughput caps. Split the work.");
    lines.push("");
    lines.push("Advisory only. boost can't reduce provider-side retries; surfacing the pattern lets you adapt.");
    return lines.join("\n");
  },
};

function totalWait(cs: Cluster[]): number {
  return cs.reduce((n, c) => n + c.totalRetryWaitMs, 0);
}

export default strategy;
