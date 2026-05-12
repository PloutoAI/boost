/**
 * Activity breakdowns. The events table already stores everything ccusage,
 * tokenuse, and CodeBurn surface as their primary dashboard tiles — this
 * module exposes those views.
 *
 * Conventions:
 * - "uncachedTokens" = `input + output + cache_creation`. Cache reads are
 *   tracked separately because they're billed at ~0.1× base price; summing
 *   them with everything else misleads.
 * - All queries take a `windowDays` parameter; default windows live in the
 *   call sites, not here.
 * - Returned arrays are sorted descending by primary metric.
 */
import type { Database as BunDatabase } from "bun:sqlite";
import { DAY_MS } from "./time.ts";
import { dollarsFor } from "./pricing.ts";

export type ToolUsage = {
  toolName: string;
  /** When non-null: the MCP server slug this tool belongs to. */
  mcpServer: string | null;
  count: number;
};

export type McpServerUsage = {
  server: string;
  toolCallCount: number;
  /** Distinct tool names from this server invoked in the window. */
  distinctTools: number;
};

export type ProjectUsage = {
  /** Resolved cwd at the time the request fired; may be null for older logs. */
  project: string;
  uncachedTokens: number;
  cacheReadTokens: number;
  requests: number;
  sessions: number;
  /** USD cost over the window, computed per-model. Null when no model is recognised. */
  costUsd: number | null;
};

export type SessionUsage = {
  sessionId: string;
  uncachedTokens: number;
  cacheReadTokens: number;
  requests: number;
  /** ISO timestamp of the first/last api_request in the session. */
  firstAt: string;
  lastAt: string;
  project: string | null;
};

export type DailyPoint = {
  /** YYYY-MM-DD in UTC. */
  date: string;
  uncachedTokens: number;
  cacheReadTokens: number;
  requests: number;
};

/** Top tools by call count over the last `windowDays`. */
export function topTools(db: BunDatabase, windowDays: number, limit: number = 10): ToolUsage[] {
  const since = sinceIso(windowDays);
  const rows = db
    .query<
      { tool_name: string | null; mcp: string | null; c: number },
      [string, number]
    >(
      `SELECT
         json_extract(payload_json, '$.tool_name') AS tool_name,
         json_extract(payload_json, '$.mcp_server_name') AS mcp,
         COUNT(*) AS c
       FROM events
       WHERE event_type = 'tool_use' AND timestamp_iso >= ?
       GROUP BY tool_name, mcp
       ORDER BY c DESC
       LIMIT ?`,
    )
    .all(since, limit);
  return rows
    .filter((r) => typeof r.tool_name === "string" && r.tool_name.length > 0)
    .map((r) => ({
      toolName: r.tool_name as string,
      mcpServer: typeof r.mcp === "string" ? r.mcp : null,
      count: r.c,
    }));
}

/** MCP servers by total tool calls in the window, with distinct-tool counts. */
export function topMcpServers(
  db: BunDatabase,
  windowDays: number,
  limit: number = 10,
): McpServerUsage[] {
  const since = sinceIso(windowDays);
  const rows = db
    .query<
      { server: string | null; calls: number; distinct_tools: number },
      [string, number]
    >(
      `SELECT
         json_extract(payload_json, '$.mcp_server_name') AS server,
         COUNT(*) AS calls,
         COUNT(DISTINCT json_extract(payload_json, '$.tool_name')) AS distinct_tools
       FROM events
       WHERE event_type = 'tool_use'
         AND timestamp_iso >= ?
         AND json_extract(payload_json, '$.mcp_server_name') IS NOT NULL
       GROUP BY server
       ORDER BY calls DESC
       LIMIT ?`,
    )
    .all(since, limit);
  return rows
    .filter((r) => typeof r.server === "string" && r.server.length > 0)
    .map((r) => ({
      server: r.server as string,
      toolCallCount: r.calls,
      distinctTools: r.distinct_tools,
    }));
}

/** Top projects by uncached spend in the window. */
export function topProjects(
  db: BunDatabase,
  windowDays: number,
  limit: number = 10,
): ProjectUsage[] {
  const since = sinceIso(windowDays);
  // Per-project per-model breakdown so we can price accurately.
  const rows = db
    .query<
      {
        project: string | null;
        model: string | null;
        input: number | null;
        output: number | null;
        creation: number | null;
        cache_read: number | null;
        requests: number;
        sessions_csv: string;
      },
      [string]
    >(
      `SELECT
         json_extract(payload_json, '$.cwd') AS project,
         json_extract(payload_json, '$.model') AS model,
         COALESCE(SUM(json_extract(payload_json, '$.input_tokens')), 0) AS input,
         COALESCE(SUM(json_extract(payload_json, '$.output_tokens')), 0) AS output,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.cache_creation_tokens'), 0)), 0) AS creation,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.cache_read_tokens'), 0)), 0) AS cache_read,
         COUNT(*) AS requests,
         GROUP_CONCAT(DISTINCT session_id) AS sessions_csv
       FROM events
       WHERE event_type = 'api_request' AND timestamp_iso >= ?
       GROUP BY project, model`,
    )
    .all(since);

  // Roll up per-project across models.
  type Roll = {
    project: string;
    uncachedTokens: number;
    cacheReadTokens: number;
    requests: number;
    sessions: Set<string>;
    costUsd: number;
    /** Track whether any contributing model had pricing, so we report
     *  null instead of 0 when nothing was priced. */
    anyPriced: boolean;
  };
  const byProject = new Map<string, Roll>();
  for (const r of rows) {
    if (typeof r.project !== "string" || r.project.length === 0) continue;
    const input = Math.round(r.input ?? 0);
    const output = Math.round(r.output ?? 0);
    const creation = Math.round(r.creation ?? 0);
    const cacheRead = Math.round(r.cache_read ?? 0);
    const dollars = dollarsFor(
      { input, output, cache_creation: creation, cache_read: cacheRead },
      r.model,
    );
    const sessionsCsv = (r.sessions_csv ?? "").split(",").filter((s) => s.length > 0);

    const existing = byProject.get(r.project);
    if (!existing) {
      byProject.set(r.project, {
        project: r.project,
        uncachedTokens: input + output + creation,
        cacheReadTokens: cacheRead,
        requests: r.requests,
        sessions: new Set(sessionsCsv),
        costUsd: dollars ?? 0,
        anyPriced: dollars !== null,
      });
    } else {
      existing.uncachedTokens += input + output + creation;
      existing.cacheReadTokens += cacheRead;
      existing.requests += r.requests;
      for (const s of sessionsCsv) existing.sessions.add(s);
      if (dollars !== null) {
        existing.costUsd += dollars;
        existing.anyPriced = true;
      }
    }
  }

  return Array.from(byProject.values())
    .map((r) => ({
      project: r.project,
      uncachedTokens: r.uncachedTokens,
      cacheReadTokens: r.cacheReadTokens,
      requests: r.requests,
      sessions: r.sessions.size,
      costUsd: r.anyPriced ? r.costUsd : null,
    }))
    .sort((a, b) => b.uncachedTokens - a.uncachedTokens)
    .slice(0, limit);
}

/** Top sessions by uncached spend in the window. */
export function topSessions(
  db: BunDatabase,
  windowDays: number,
  limit: number = 5,
): SessionUsage[] {
  const since = sinceIso(windowDays);
  const rows = db
    .query<
      {
        session_id: string | null;
        uncached: number | null;
        cache_read: number | null;
        requests: number;
        first_at: string | null;
        last_at: string | null;
        project: string | null;
      },
      [string, number]
    >(
      `SELECT
         session_id,
         COALESCE(SUM(
           json_extract(payload_json, '$.input_tokens') +
           json_extract(payload_json, '$.output_tokens') +
           COALESCE(json_extract(payload_json, '$.cache_creation_tokens'), 0)
         ), 0) AS uncached,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.cache_read_tokens'), 0)), 0) AS cache_read,
         COUNT(*) AS requests,
         MIN(timestamp_iso) AS first_at,
         MAX(timestamp_iso) AS last_at,
         MAX(json_extract(payload_json, '$.cwd')) AS project
       FROM events
       WHERE event_type = 'api_request'
         AND session_id IS NOT NULL
         AND timestamp_iso >= ?
       GROUP BY session_id
       ORDER BY uncached DESC
       LIMIT ?`,
    )
    .all(since, limit);
  return rows
    .filter((r) => typeof r.session_id === "string" && r.session_id.length > 0)
    .map((r) => ({
      sessionId: r.session_id as string,
      uncachedTokens: Math.round(r.uncached ?? 0),
      cacheReadTokens: Math.round(r.cache_read ?? 0),
      requests: r.requests,
      firstAt: r.first_at ?? "",
      lastAt: r.last_at ?? "",
      project: typeof r.project === "string" ? r.project : null,
    }));
}

/** Daily token totals over the last `windowDays`. Sorted oldest → newest. */
export function dailySeries(db: BunDatabase, windowDays: number): DailyPoint[] {
  const since = sinceIso(windowDays);
  const rows = db
    .query<
      {
        date: string;
        uncached: number | null;
        cache_read: number | null;
        requests: number;
      },
      [string]
    >(
      `SELECT
         substr(timestamp_iso, 1, 10) AS date,
         COALESCE(SUM(
           json_extract(payload_json, '$.input_tokens') +
           json_extract(payload_json, '$.output_tokens') +
           COALESCE(json_extract(payload_json, '$.cache_creation_tokens'), 0)
         ), 0) AS uncached,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.cache_read_tokens'), 0)), 0) AS cache_read,
         COUNT(*) AS requests
       FROM events
       WHERE event_type = 'api_request' AND timestamp_iso >= ?
       GROUP BY date
       ORDER BY date ASC`,
    )
    .all(since);
  return rows.map((r) => ({
    date: r.date,
    uncachedTokens: Math.round(r.uncached ?? 0),
    cacheReadTokens: Math.round(r.cache_read ?? 0),
    requests: r.requests,
  }));
}

/**
 * Per-day per-model uncached-token breakdown. Used by the stacked daily
 * bar chart to show model mix × time in one view.
 *
 * Shape: one entry per UTC date in the window, each carrying an array of
 * `{ model, tokens }` pairs sorted by tokens desc.
 */
export type DailyModelPoint = {
  date: string;
  perModel: Array<{ model: string; tokens: number }>;
};

export function dailyByModelSeries(db: BunDatabase, windowDays: number): DailyModelPoint[] {
  const since = sinceIso(windowDays);
  const rows = db
    .query<
      {
        date: string;
        model: string | null;
        uncached: number | null;
      },
      [string]
    >(
      `SELECT
         substr(timestamp_iso, 1, 10) AS date,
         json_extract(payload_json, '$.model') AS model,
         COALESCE(SUM(
           json_extract(payload_json, '$.input_tokens') +
           json_extract(payload_json, '$.output_tokens') +
           COALESCE(json_extract(payload_json, '$.cache_creation_tokens'), 0)
         ), 0) AS uncached
       FROM events
       WHERE event_type = 'api_request' AND timestamp_iso >= ?
       GROUP BY date, model
       ORDER BY date ASC, uncached DESC`,
    )
    .all(since);

  const byDate = new Map<string, Array<{ model: string; tokens: number }>>();
  for (const r of rows) {
    if (!r.date) continue;
    const arr = byDate.get(r.date) ?? [];
    if (typeof r.model === "string" && r.model.length > 0) {
      arr.push({ model: r.model, tokens: Math.round(r.uncached ?? 0) });
    }
    byDate.set(r.date, arr);
  }
  const out: DailyModelPoint[] = [];
  for (const [date, perModel] of byDate.entries()) {
    out.push({ date, perModel });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function sinceIso(windowDays: number): string {
  return new Date(Date.now() - windowDays * DAY_MS).toISOString();
}
