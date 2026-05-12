/**
 * `unused-mcp-disable` — flag MCP servers (from any source boost knows
 * about) whose tools have not been called in N days (default 60).
 *
 * v0.1 reads servers from:
 *   - user `~/.claude/settings.json`
 *   - project `.mcp.json` (with parent walk)
 *   - plugin `.mcp.json` and plugin manifests
 *
 * Per-server install grace: a server whose source file is < 7 days old AND
 * has zero events ever is treated as "freshly installed" and skipped. This
 * replaces the old "skip the entire detector if settings.json mtime is
 * recent" behavior, which was too aggressive — editing one line silenced
 * the detector for all servers.
 *
 * Cold-start gate: needs ≥ 14 days of data.
 *
 * Fix scope: only servers declared in user `settings.json` are
 * auto-disabled. Project `.mcp.json` and plugin sources are surfaced as
 * advisory because their files are often shared (committed to a repo,
 * shipped by a plugin); writing them belongs to a future scope.
 */
import * as fs from "node:fs";
import type { Finding, Fix } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import { normalizeServerName } from "../data/settings-json.ts";
import type { McpServerSource } from "../data/mcp-sources.ts";
import { weeklySavingsPct } from "../summary.ts";
import { DAY_MS } from "../time.ts";

const id = "unused-mcp-disable";
const version = 2;
const WINDOW_DAYS = 60;
const MIN_DAYS = 14;
const INSTALL_GRACE_DAYS = 7;
const TOKENS_PER_SCHEMA = 1000;

const strategy: StrategyDefinition = {
  id,
  version,
  category: "clear-wins",
  defaultSeverity: "high",
  safeToApply: true,

  title: (f) =>
    `Disable ${f.affectedItems.length} unused MCP server${f.affectedItems.length === 1 ? "" : "s"}`,

  detect: (ctx) => {
    if (ctx.daysOfDataAvailable < MIN_DAYS) return null;
    const allServers = ctx.config.mcpServers;
    if (allServers.length === 0) return null;

    const since = new Date(ctx.now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
    const firedRecent = firedServers(ctx.events.db, since);
    const firedEver = firedServers(ctx.events.db, "1970-01-01T00:00:00Z");

    const candidates: McpServerSource[] = [];
    for (const server of allServers) {
      if (server.disabled) continue;
      if (firedRecent.has(normalizeServerName(server.name))) continue;
      // Per-server install grace: skip if source file is < 7d old AND we've
      // never seen this server fire any tool.
      if (isFreshlyInstalled(server) && !firedEver.has(normalizeServerName(server.name))) {
        continue;
      }
      // v0.1 only auto-applies user-settings entries (we don't write
      // project/plugin files; see strategy doc-comment). Surface non-writable
      // servers in evidence but exclude from fixes.
      if (server.source !== "user-settings") continue;
      candidates.push(server);
    }
    if (candidates.length === 0) return null;

    const tokensPerRequest = candidates.length * TOKENS_PER_SCHEMA;
    const weeklyPct = weeklySavingsPct(ctx.events.db, tokensPerRequest);

    const fixes: Fix[] = candidates.map((s) => ({
      kind: "modify-settings-key",
      payload: {
        filePath: s.sourcePath,
        jsonPath: `mcpServers.${s.name}.disabled`,
        newValue: true,
      },
    }));

    const finding: Finding = {
      strategyId: id,
      strategyVersion: version,
      category: "clear-wins",
      severity: candidates.length >= 3 ? "high" : "medium",
      safeToApply: true,
      title: "",
      affectedItems: candidates.map((s) => s.name),
      estimatedTokensSavedPerRequest: tokensPerRequest,
      estimatedPercentOfWeeklyUsage: weeklyPct,
      evidence: {
        observedAtIso: ctx.now.toISOString(),
        windowDays: WINDOW_DAYS,
        signals: {
          configuredServers: allServers.map((s) => ({
            name: s.name,
            source: s.source,
            sourcePath: s.sourcePath,
          })),
          firedInWindow: Array.from(firedRecent),
          flagged: candidates.map((s) => ({ name: s.name, source: s.source, sourcePath: s.sourcePath })),
        },
        humanReadable: `${candidates.length} MCP server(s) configured in user settings but no tool calls in the last ${WINDOW_DAYS} days.`,
      },
      fixes: fixes as unknown as readonly [Fix, ...Fix[]],
    };
    finding.title = strategy.title(finding);
    return finding;
  },

  explain: (f) => {
    const items = f.affectedItems
      .map((s) => `  • ${s}        no calls in last ${WINDOW_DAYS} days`)
      .join("\n");
    const tokens = f.estimatedTokensSavedPerRequest;
    const pct = f.estimatedPercentOfWeeklyUsage;
    const pctText = pct === null ? "" : ` — roughly ${Math.round(pct)}% of your weekly token usage`;
    return `These MCP servers are loaded into every Claude Code session but their tools haven't been called in ${WINDOW_DAYS}+ days:

${items}

Saves about ${tokens.toLocaleString()} tokens per request${pctText}.

Reversible: settings backup saved, "boost revert" to undo.

Note: project-level (.mcp.json) and plugin-defined servers are detected and shown in the evidence dossier but not auto-modified — those files are often shared and writing them is out of scope for v0.1.`;
  },
};

function firedServers(db: import("bun:sqlite").Database, sinceIso: string): Set<string> {
  const rows = db
    .query<{ server_name: string }, [string]>(
      `SELECT DISTINCT json_extract(payload_json, '$.mcp_server_name') AS server_name
       FROM events
       WHERE event_type = 'tool_use'
         AND timestamp_iso >= ?
         AND json_extract(payload_json, '$.mcp_server_name') IS NOT NULL`,
    )
    .all(sinceIso);
  const out = new Set<string>();
  for (const r of rows) if (r.server_name) out.add(normalizeServerName(r.server_name));
  return out;
}

function isFreshlyInstalled(server: McpServerSource): boolean {
  try {
    const st = fs.statSync(server.sourcePath);
    return Date.now() - st.mtimeMs < INSTALL_GRACE_DAYS * DAY_MS;
  } catch {
    return false;
  }
}

export default strategy;
