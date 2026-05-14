/**
 * Summary stats used in the JSON output and TUI header.
 *
 * Token columns are kept *separate* — never collapsed into a single number —
 * because cache reads are ~0.1× base price and summing them with input/output
 * misleads anyone reading the headline. Cache hit rate is its own first-class
 * metric (cache_read / (cache_read + uncached_input)).
 */
import type { Database as BunDatabase } from "bun:sqlite";
import { formatCompactNumber as fmt } from "./format.ts";
import { DAY_MS } from "./time.ts";
import { dollarsFor } from "./pricing.ts";

export type Summary = {
  /** Sum of input + output + cache_creation. The honest "billable" denominator. */
  uncached_tokens_last_7_days: number;
  /** Cache reads alone. ~0.1× base price; surfacing separately keeps the headline honest. */
  cache_read_tokens_last_7_days: number;
  input_tokens_last_7_days: number;
  output_tokens_last_7_days: number;
  cache_creation_tokens_last_7_days: number;
  /** Reads / (reads + uncached input). 0 when no data. Capped to 0.95. */
  cache_hit_rate_last_7_days: number;
  sessions_last_7_days: number;
  /** Sum of clear-wins predicted savings, post-clamp. */
  total_predicted_savings_pct: number;
  /**
   * Estimated USD cost over the last 7 days, summed per-model using bundled
   * pricing. Null if no recognised models — never silently 0.
   */
  cost_last_7_days_usd: number | null;
  /**
   * Uncached share of the total bill — input + output + cache_creation
   * priced per model, excluding cache reads. This is the right denominator
   * for "% saved" projections from detectors, since detector percentages
   * are computed against `uncachedTokensLastNDays`. Multiplying a detector
   * percentage by `cost_last_7_days_usd` overstates because cache reads
   * dominate the total bill but don't shrink at the same rate as uncached
   * spend.
   */
  uncached_cost_last_7_days_usd: number | null;
  rate_limit_pressure: RateLimitPressure;
};

export type RateLimitPressure = {
  level: "low" | "medium" | "high";
  score: number;
  drivers: string[];
};

export type TokenBreakdown = {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
};

/** Compute the canonical summary block used by JSON, TUI header, and check. */
export function summarize(db: BunDatabase, totalPredictedPct: number): Summary {
  const sevenDaysAgoIso = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const tokens = tokenBreakdownSince(db, sevenDaysAgoIso);
  const sessions = db
    .query<
      { c: number },
      [string]
    >(
      `SELECT COUNT(DISTINCT session_id) AS c FROM events WHERE timestamp_iso >= ? AND session_id IS NOT NULL`,
    )
    .get(sevenDaysAgoIso);

  const summaryBase = {
    uncached_tokens_last_7_days: tokens.input + tokens.output + tokens.cache_creation,
    cache_read_tokens_last_7_days: tokens.cache_read,
    input_tokens_last_7_days: tokens.input,
    output_tokens_last_7_days: tokens.output,
    cache_creation_tokens_last_7_days: tokens.cache_creation,
    cache_hit_rate_last_7_days: cacheHitRate(tokens),
    sessions_last_7_days: sessions?.c ?? 0,
    total_predicted_savings_pct: Math.round(totalPredictedPct),
    cost_last_7_days_usd: costLastNDays(db, 7),
    uncached_cost_last_7_days_usd: uncachedCostLastNDays(db, 7),
  };
  return {
    ...summaryBase,
    rate_limit_pressure: rateLimitPressure(db, summaryBase),
  };
}

/**
 * Sum of input + output + cache_creation costs (i.e. excluding cache
 * reads). The "uncached bill" — the right denominator for projecting
 * dollar savings from detectors whose percentages are measured against
 * uncached tokens.
 */
export function uncachedCostLastNDays(db: BunDatabase, days: number): number | null {
  const usage = modelUsageLastNDays(db, days);
  if (usage.length === 0) return null;
  let total = 0;
  let priced = false;
  for (const u of usage) {
    const dollars = dollarsFor(
      {
        input: u.inputTokens,
        output: u.outputTokens,
        cache_creation: u.cacheCreationTokens,
        cache_read: 0,
      },
      u.model,
    );
    if (dollars !== null) {
      total += dollars;
      priced = true;
    }
  }
  return priced ? total : null;
}

/**
 * Sum USD cost across all api_request rows in the window, priced per
 * model. Models with no pricing entry contribute null (skipped); if
 * every model is unknown the total is null too — we don't lie about
 * what we can't price.
 */
export function costLastNDays(db: BunDatabase, days: number): number | null {
  const usage = modelUsageLastNDays(db, days);
  if (usage.length === 0) return null;
  let total = 0;
  let priced = false;
  for (const u of usage) {
    const dollars = dollarsFor(
      {
        input: u.inputTokens,
        output: u.outputTokens,
        cache_creation: u.cacheCreationTokens,
        cache_read: u.cacheReadTokens,
      },
      u.model,
    );
    if (dollars !== null) {
      total += dollars;
      priced = true;
    }
  }
  return priced ? total : null;
}

function rateLimitPressure(db: BunDatabase, summary: Omit<Summary, "rate_limit_pressure">): RateLimitPressure {
  const drivers: string[] = [];
  let score = 0;

  const uncachedPerSession = summary.uncached_tokens_last_7_days / Math.max(1, summary.sessions_last_7_days);
  if (uncachedPerSession >= 2_000_000) {
    score += 35;
    drivers.push(`high uncached/session (${fmt(uncachedPerSession)})`);
  } else if (uncachedPerSession >= 750_000) {
    score += 20;
    drivers.push(`elevated uncached/session (${fmt(uncachedPerSession)})`);
  }

  if (summary.uncached_tokens_last_7_days >= 20_000_000) {
    score += 25;
    drivers.push(`high weekly uncached (${fmt(summary.uncached_tokens_last_7_days)})`);
  } else if (summary.uncached_tokens_last_7_days >= 5_000_000) {
    score += 15;
    drivers.push(`meaningful weekly uncached (${fmt(summary.uncached_tokens_last_7_days)})`);
  }

  if (summary.cache_hit_rate_last_7_days < 0.5 && summary.sessions_last_7_days > 0) {
    score += 15;
    drivers.push(`low cache hit rate (${Math.round(summary.cache_hit_rate_last_7_days * 100)}%)`);
  }

  const models = modelUsageLastNDays(db, 7);
  const totalModelUncached = models.reduce((n, m) => n + m.uncachedTokens, 0);
  const top = models[0];
  if (top && totalModelUncached > 0) {
    const share = top.uncachedTokens / totalModelUncached;
    if (!isCheapModel(top.model) && share >= 0.8) {
      score += share >= 0.95 ? 25 : 15;
      drivers.push(`${top.model} dominates uncached (${Math.round(share * 100)}%)`);
    }
  }

  if (summary.total_predicted_savings_pct >= 15) {
    score += 15;
    drivers.push(`clear local savings available (${summary.total_predicted_savings_pct}%)`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= 55 ? "high" : score >= 25 ? "medium" : "low";
  return { level, score, drivers: drivers.slice(0, 4) };
}

/** Per-column token breakdown over `[since, now)`. */
export function tokenBreakdownSince(db: BunDatabase, sinceIso: string): TokenBreakdown {
  const row = db
    .query<
      {
        input: number | null;
        output: number | null;
        creation: number | null;
        read: number | null;
      },
      [string]
    >(
      `SELECT
         COALESCE(SUM(json_extract(payload_json, '$.input_tokens')), 0) AS input,
         COALESCE(SUM(json_extract(payload_json, '$.output_tokens')), 0) AS output,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.cache_creation_tokens'), 0)), 0) AS creation,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.cache_read_tokens'), 0)), 0) AS read
       FROM events
       WHERE event_type = 'api_request' AND timestamp_iso >= ?`,
    )
    .get(sinceIso);
  return {
    input: Math.round(row?.input ?? 0),
    output: Math.round(row?.output ?? 0),
    cache_creation: Math.round(row?.creation ?? 0),
    cache_read: Math.round(row?.read ?? 0),
  };
}

/** Distinct sessions seen in the last N days. Used as a "user is active" gate. */
export function sessionsLastNDays(db: BunDatabase, days: number): number {
  const ago = new Date(Date.now() - days * DAY_MS).toISOString();
  const row = db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(DISTINCT session_id) AS c FROM events
        WHERE timestamp_iso >= ? AND session_id IS NOT NULL`,
    )
    .get(ago);
  return row?.c ?? 0;
}

/** Approximate request count per week — used by the savings math. */
export function requestsPerWeek(db: BunDatabase): number {
  const sevenDaysAgoIso = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const row = db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) AS c FROM events WHERE event_type = 'api_request' AND timestamp_iso >= ?`,
    )
    .get(sevenDaysAgoIso);
  return row?.c ?? 0;
}

/**
 * Un-cached portion of weekly token spend. The right denominator for
 * "how much would a fix actually shave" — using all tokens (including
 * cache reads) biases percentages downward by 5–10× on heavy-cache users.
 */
export function uncachedTokensLastNDays(db: BunDatabase, days: number): number {
  const ago = new Date(Date.now() - days * DAY_MS).toISOString();
  const t = tokenBreakdownSince(db, ago);
  return t.input + t.output + t.cache_creation;
}

/**
 * Translate "tokens saved per request" into a weekly %, using un-cached
 * spend as the denominator. Discounted by measured cache hit rate.
 * Clamped to 99.9 so a low-data week can't produce >100% answers.
 */
export function weeklySavingsPct(
  db: BunDatabase,
  tokensSavedPerRequest: number,
  cacheHitRateOverride?: number,
): number {
  const requests = Math.max(1, requestsPerWeek(db));
  const denom = Math.max(1, uncachedTokensLastNDays(db, 7));
  const hit = cacheHitRateOverride ?? estimateCacheHitRate(db);
  const effectivePerRequest = tokensSavedPerRequest * (1 - hit);
  const pct = (effectivePerRequest * requests * 100) / denom;
  if (!Number.isFinite(pct) || pct < 0) return 0;
  return Math.min(99.9, Math.round(pct * 10) / 10);
}

/**
 * Per-model uncached-token breakdown over the last N days. Returned sorted
 * by tokens descending. Used by the model-mix detector and as evidence in
 * the no-findings empty state.
 */
export type ModelUsage = {
  model: string;
  /** input + output + cache_creation. */
  uncachedTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  requests: number;
};

export function modelUsageLastNDays(db: BunDatabase, days: number): ModelUsage[] {
  const ago = new Date(Date.now() - days * DAY_MS).toISOString();
  const rows = db
    .query<
      {
        model: string | null;
        input: number | null;
        output: number | null;
        creation: number | null;
        cache_read: number | null;
        requests: number | null;
      },
      [string]
    >(
      `SELECT
         json_extract(payload_json, '$.model') AS model,
         COALESCE(SUM(json_extract(payload_json, '$.input_tokens')), 0) AS input,
         COALESCE(SUM(json_extract(payload_json, '$.output_tokens')), 0) AS output,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.cache_creation_tokens'), 0)), 0) AS creation,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.cache_read_tokens'), 0)), 0) AS cache_read,
         COUNT(*) AS requests
       FROM events
       WHERE event_type = 'api_request' AND timestamp_iso >= ?
       GROUP BY json_extract(payload_json, '$.model')
       ORDER BY (input + output + creation) DESC`,
    )
    .all(ago);
  return rows
    .filter((r) => typeof r.model === "string" && r.model.length > 0)
    .map((r) => {
      const input = Math.round(r.input ?? 0);
      const output = Math.round(r.output ?? 0);
      const creation = Math.round(r.creation ?? 0);
      return {
        model: r.model as string,
        uncachedTokens: input + output + creation,
        inputTokens: input,
        outputTokens: output,
        cacheCreationTokens: creation,
        cacheReadTokens: Math.round(r.cache_read ?? 0),
        requests: r.requests ?? 0,
      };
    });
}

/** Cache hit rate over the last 7 days. 0 if no data. Capped at 0.95. */
export function estimateCacheHitRate(db: BunDatabase): number {
  const sevenDaysAgoIso = new Date(Date.now() - 7 * DAY_MS).toISOString();
  return cacheHitRate(tokenBreakdownSince(db, sevenDaysAgoIso));
}

function cacheHitRate(t: TokenBreakdown): number {
  const reads = t.cache_read;
  const uncachedInput = t.input + t.cache_creation;
  const denom = reads + uncachedInput;
  if (denom <= 0) return 0;
  return Math.max(0, Math.min(0.95, reads / denom));
}

/**
 * True for models we consider "cheap enough that the user doesn't need
 * to be nudged off them." Used by both the rate-limit-pressure score
 * and the model-mix detector; keep them sharing this predicate so
 * "cheap" never drifts between the two surfaces.
 */
export function isCheapModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("haiku") || (m.includes("sonnet") && !m.includes("opus"));
}

/**
 * Raw api_error rows over the last N days, ordered by session then time
 * so consumers can stream-cluster without an extra sort. Returns the
 * minimum the retry-storm detector needs — no payload field is read here,
 * so a future schema change to api_error doesn't ripple through summary.
 */
export type ApiErrorRow = {
  sessionId: string;
  timestampMs: number;
  payloadJson: string;
};

export function apiErrorsLastNDays(db: BunDatabase, days: number): ApiErrorRow[] {
  const ago = new Date(Date.now() - days * DAY_MS).toISOString();
  const rows = db
    .query<
      { session_id: string | null; timestamp_iso: string; payload_json: string },
      [string]
    >(
      `SELECT session_id, timestamp_iso, payload_json
         FROM events
        WHERE event_type = 'api_error'
          AND timestamp_iso >= ?
          AND session_id IS NOT NULL
        ORDER BY session_id, timestamp_iso`,
    )
    .all(ago);
  const out: ApiErrorRow[] = [];
  for (const r of rows) {
    if (!r.session_id) continue;
    const ts = Date.parse(r.timestamp_iso);
    if (!Number.isFinite(ts)) continue;
    out.push({ sessionId: r.session_id, timestampMs: ts, payloadJson: r.payload_json });
  }
  return out;
}

/**
 * Per-session uncached-token split: sidechain (Task() subagent turns) vs
 * total. Used by the subagent-cost detector to flag sessions where
 * subagent spend is a material slice of the session's cost.
 *
 * The query leverages the partial functional index on
 * `json_extract($.is_sidechain)` (api_request rows only). Sessions with
 * zero sidechain spend are filtered out by `HAVING`; the result is
 * ordered by absolute sidechain tokens so the detector can take the
 * top-N noisy sessions directly.
 */
export type SessionSidechainBreakdown = {
  sessionId: string;
  totalUncachedTokens: number;
  sidechainUncachedTokens: number;
  totalRequests: number;
  sidechainRequests: number;
};

export function sessionSidechainBreakdownLastNDays(
  db: BunDatabase,
  days: number,
): SessionSidechainBreakdown[] {
  const ago = new Date(Date.now() - days * DAY_MS).toISOString();
  const rows = db
    .query<
      {
        session_id: string | null;
        total_uncached: number | null;
        sidechain_uncached: number | null;
        total_requests: number | null;
        sidechain_requests: number | null;
      },
      [string]
    >(
      `SELECT
         session_id,
         SUM(
           json_extract(payload_json, '$.input_tokens') +
           json_extract(payload_json, '$.output_tokens') +
           COALESCE(json_extract(payload_json, '$.cache_creation_tokens'), 0)
         ) AS total_uncached,
         SUM(CASE
               WHEN json_extract(payload_json, '$.is_sidechain') = 1
               THEN json_extract(payload_json, '$.input_tokens') +
                    json_extract(payload_json, '$.output_tokens') +
                    COALESCE(json_extract(payload_json, '$.cache_creation_tokens'), 0)
               ELSE 0
             END) AS sidechain_uncached,
         COUNT(*) AS total_requests,
         SUM(CASE WHEN json_extract(payload_json, '$.is_sidechain') = 1 THEN 1 ELSE 0 END) AS sidechain_requests
       FROM events
       WHERE event_type = 'api_request'
         AND timestamp_iso >= ?
         AND session_id IS NOT NULL
       GROUP BY session_id
       HAVING sidechain_uncached > 0
       ORDER BY sidechain_uncached DESC`,
    )
    .all(ago);
  return rows
    .filter((r) => typeof r.session_id === "string" && r.session_id.length > 0)
    .map((r) => ({
      sessionId: r.session_id as string,
      totalUncachedTokens: Math.round(r.total_uncached ?? 0),
      sidechainUncachedTokens: Math.round(r.sidechain_uncached ?? 0),
      totalRequests: r.total_requests ?? 0,
      sidechainRequests: r.sidechain_requests ?? 0,
    }));
}

/**
 * Per-session cost + cwd list, filtered to sessions whose total USD
 * spend over the last N days is at least `minCostUsd`. Returned sorted
 * by cost descending. Used by the unshipped-cost detector to find
 * expensive sessions worth correlating against git history.
 *
 * Sessions whose model is unknown to the pricing table contribute null
 * to `costUsd` and are filtered out — we don't fabricate cost for
 * `<synthetic>` rows or future models we haven't priced yet.
 */
export type SessionCostBreakdown = {
  sessionId: string;
  costUsd: number;
  uncachedTokens: number;
  cacheReadTokens: number;
  requests: number;
  firstAtIso: string;
  lastAtIso: string;
  cwds: string[];
};

export function expensiveSessionsLastNDays(
  db: BunDatabase,
  days: number,
  minCostUsd: number = 5,
): SessionCostBreakdown[] {
  const ago = new Date(Date.now() - days * DAY_MS).toISOString();
  // Per-session per-model token breakdown — needed for accurate pricing.
  const rows = db
    .query<
      {
        session_id: string;
        model: string | null;
        input: number | null;
        output: number | null;
        creation: number | null;
        cache_read: number | null;
        requests: number | null;
        first_at: string;
        last_at: string;
        cwds_csv: string | null;
      },
      [string]
    >(
      `SELECT
         session_id,
         json_extract(payload_json, '$.model') AS model,
         COALESCE(SUM(json_extract(payload_json, '$.input_tokens')), 0) AS input,
         COALESCE(SUM(json_extract(payload_json, '$.output_tokens')), 0) AS output,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.cache_creation_tokens'), 0)), 0) AS creation,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.cache_read_tokens'), 0)), 0) AS cache_read,
         COUNT(*) AS requests,
         MIN(timestamp_iso) AS first_at,
         MAX(timestamp_iso) AS last_at,
         GROUP_CONCAT(DISTINCT json_extract(payload_json, '$.cwd')) AS cwds_csv
       FROM events
       WHERE event_type = 'api_request'
         AND timestamp_iso >= ?
         AND session_id IS NOT NULL
       GROUP BY session_id, json_extract(payload_json, '$.model')`,
    )
    .all(ago);

  // Roll up per-session: sum costs across models, merge time bounds,
  // de-dupe cwds.
  const bySession = new Map<string, SessionCostBreakdown>();
  for (const r of rows) {
    if (!r.session_id) continue;
    const dollars = dollarsFor(
      {
        input: Math.round(r.input ?? 0),
        output: Math.round(r.output ?? 0),
        cache_creation: Math.round(r.creation ?? 0),
        cache_read: Math.round(r.cache_read ?? 0),
      },
      r.model,
    );
    const existing = bySession.get(r.session_id);
    const uncached = Math.round((r.input ?? 0) + (r.output ?? 0) + (r.creation ?? 0));
    const cacheRead = Math.round(r.cache_read ?? 0);
    const reqs = r.requests ?? 0;
    const cwds = (r.cwds_csv ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!existing) {
      bySession.set(r.session_id, {
        sessionId: r.session_id,
        costUsd: dollars ?? 0,
        uncachedTokens: uncached,
        cacheReadTokens: cacheRead,
        requests: reqs,
        firstAtIso: r.first_at,
        lastAtIso: r.last_at,
        cwds,
      });
    } else {
      existing.costUsd += dollars ?? 0;
      existing.uncachedTokens += uncached;
      existing.cacheReadTokens += cacheRead;
      existing.requests += reqs;
      if (r.first_at < existing.firstAtIso) existing.firstAtIso = r.first_at;
      if (r.last_at > existing.lastAtIso) existing.lastAtIso = r.last_at;
      for (const c of cwds) {
        if (!existing.cwds.includes(c)) existing.cwds.push(c);
      }
    }
  }

  return Array.from(bySession.values())
    .filter((s) => s.costUsd >= minCostUsd)
    .sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Per-session count of auto_compact events. Each compact discards the
 * prior turn's cache (next turn rebuilds from a fresh prefix) and pays
 * tokens to summarize history; repeated compacts in the same session
 * mean the user is refilling context faster than the model can hold it.
 *
 * Returns sessions sorted by compact count desc, filtered to those with
 * at least one compact (small left-joins handle "session with no
 * compacts" cases — the detector filters further on its threshold).
 */
export type SessionCompactBreakdown = {
  sessionId: string;
  compactCount: number;
  totalPreTokens: number;
  firstCompactIso: string | null;
  lastCompactIso: string | null;
};

export function sessionCompactBreakdownLastNDays(
  db: BunDatabase,
  days: number,
): SessionCompactBreakdown[] {
  const ago = new Date(Date.now() - days * DAY_MS).toISOString();
  const rows = db
    .query<
      {
        session_id: string | null;
        compact_count: number | null;
        total_pre_tokens: number | null;
        first_iso: string | null;
        last_iso: string | null;
      },
      [string]
    >(
      `SELECT
         session_id,
         COUNT(*) AS compact_count,
         COALESCE(SUM(json_extract(payload_json, '$.pre_tokens')), 0) AS total_pre_tokens,
         MIN(timestamp_iso) AS first_iso,
         MAX(timestamp_iso) AS last_iso
       FROM events
       WHERE event_type = 'auto_compact'
         AND timestamp_iso >= ?
         AND session_id IS NOT NULL
       GROUP BY session_id
       ORDER BY compact_count DESC`,
    )
    .all(ago);
  return rows
    .filter((r) => typeof r.session_id === "string" && r.session_id.length > 0)
    .map((r) => ({
      sessionId: r.session_id as string,
      compactCount: r.compact_count ?? 0,
      totalPreTokens: Math.round(r.total_pre_tokens ?? 0),
      firstCompactIso: r.first_iso,
      lastCompactIso: r.last_iso,
    }));
}

/** Per-Bash-command-stem response-size breakdown over the window.
 *  Only successful tool_results above `minBytes` count toward the sum. */
export type ShellOutputStem = {
  stem: string;
  calls: number;
  totalBytes: number;
};

export function shellOutputBreakdownLastNDays(
  db: BunDatabase,
  days: number,
  minBytes: number,
): ShellOutputStem[] {
  const ago = new Date(Date.now() - days * DAY_MS).toISOString();
  const rows = db
    .query<
      { stem: string | null; calls: number | null; total_bytes: number | null },
      [string, number]
    >(
      `SELECT json_extract(u.payload_json, '$.bash_command_stem') AS stem,
              COUNT(*) AS calls,
              SUM(CAST(json_extract(r.payload_json, '$.result_size_bytes') AS INTEGER)) AS total_bytes
         FROM events u
         JOIN events r
           ON json_extract(r.payload_json, '$.tool_use_id')
            = json_extract(u.payload_json, '$.tool_use_id')
        WHERE u.event_type = 'tool_use'
          AND r.event_type = 'tool_result'
          AND u.timestamp_iso >= ?
          AND json_extract(u.payload_json, '$.tool_name') = 'Bash'
          AND json_extract(u.payload_json, '$.bash_command_stem') IS NOT NULL
          AND json_extract(r.payload_json, '$.success') = 1
          AND CAST(json_extract(r.payload_json, '$.result_size_bytes') AS INTEGER) >= ?
        GROUP BY stem`,
    )
    .all(ago, minBytes);

  return rows
    .filter((r) => typeof r.stem === "string" && r.stem.length > 0)
    .map((r) => ({
      stem: r.stem as string,
      calls: r.calls ?? 0,
      totalBytes: r.total_bytes ?? 0,
    }));
}

