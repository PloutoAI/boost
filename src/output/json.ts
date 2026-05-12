/**
 * `boost --json` output. Stable contract — see `docs/json-schema.md`.
 *
 * Schema version 2: per-token-type summary fields + cache hit rate.
 * The `activity` block was added additively after v2 went out; consumers
 * should ignore unknown top-level fields.
 */
import type { Database as BunDatabase } from "bun:sqlite";
import type { Finding, Operation } from "../types.ts";
import { recentOperations } from "../apply/revert.ts";
import { summarize, modelUsageLastNDays, type Summary, type ModelUsage } from "../summary.ts";
import {
  dailySeries,
  topMcpServers,
  topProjects,
  topSessions,
  topTools,
  type DailyPoint,
  type McpServerUsage,
  type ProjectUsage,
  type SessionUsage,
  type ToolUsage,
} from "../activity.ts";

const ACTIVITY_WINDOW_DAYS = 7;

export type JsonOutput = {
  schema_version: 2;
  generated_at: string;
  summary: Summary;
  /**
   * Always-on activity breakdowns over the last 7 days. Surfaces what the
   * other tools (ccusage, tokenuse, CodeBurn) put on their dashboards.
   * Additive to schema v2 — consumers ignore unknown keys.
   */
  activity: {
    window_days: number;
    models: ModelUsage[];
    top_tools: ToolUsage[];
    top_mcp_servers: McpServerUsage[];
    top_projects: ProjectUsage[];
    top_sessions: SessionUsage[];
    daily: DailyPoint[];
  };
  findings: {
    clear_wins: Finding[];
    trade_offs: Finding[];
  };
  recent_operations: Operation[];
};

export function buildJson(db: BunDatabase, findings: Finding[], totalSavingsPct: number): JsonOutput {
  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    summary: summarize(db, totalSavingsPct),
    activity: {
      window_days: ACTIVITY_WINDOW_DAYS,
      models: modelUsageLastNDays(db, ACTIVITY_WINDOW_DAYS),
      top_tools: topTools(db, ACTIVITY_WINDOW_DAYS, 10),
      top_mcp_servers: topMcpServers(db, ACTIVITY_WINDOW_DAYS, 10),
      top_projects: topProjects(db, ACTIVITY_WINDOW_DAYS, 10),
      top_sessions: topSessions(db, ACTIVITY_WINDOW_DAYS, 5),
      daily: dailySeries(db, ACTIVITY_WINDOW_DAYS),
    },
    findings: {
      clear_wins: findings.filter((f) => f.category === "clear-wins"),
      trade_offs: findings.filter((f) => f.category === "trade-offs"),
    },
    recent_operations: recentOperations(db, 5),
  };
}

export function renderJson(out: JsonOutput): string {
  return JSON.stringify(out);
}
