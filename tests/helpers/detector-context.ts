/**
 * Test helper: build a DetectorContext from a synthetic in-memory database
 * and a partial config snapshot.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { LoopDatabase } from "../../src/db.ts";
import type { ConfigSnapshot, DetectorContext } from "../../src/strategy.ts";
import type { Finding } from "../../src/types.ts";
import type { ClaudeMdFile } from "../../src/data/claude-md.ts";
import type { ClaudeSettings, McpServerConfig } from "../../src/data/settings-json.ts";
import type { McpServerSource } from "../../src/data/mcp-sources.ts";
import type { Skill } from "../../src/data/skills.ts";
import type { Plugin } from "../../src/data/plugins.ts";

export type FakeContextOptions = {
  /** Days of data the strategies should believe is available. */
  daysOfDataAvailable?: number;
  /** Pre-populated settings.json. */
  settings?: ClaudeSettings | null;
  /**
   * Merged MCP servers (from every source). Defaults to whatever's in
   * `settings.mcpServers`, mapped as `source: "user-settings"`.
   */
  mcpServers?: McpServerSource[];
  claudeMdFiles?: ClaudeMdFile[];
  skills?: Skill[];
  plugins?: Plugin[];
  recentDismissals?: Set<string>;
  now?: Date;
  /** Run after the DB is opened — pre-populate `events` here. */
  seed?: (db: Database) => void;
};

export type FakeContext = {
  ctx: DetectorContext;
  db: Database;
  cleanup: () => void;
};

/**
 * Open a fresh DB at `$BOOST_HOME` (assumes the caller already set it via
 * `makeTempHome`), seed events, return a context shaped for detectors.
 */
export function makeDetectorContext(opts: FakeContextOptions = {}): FakeContext {
  const handle = LoopDatabase.open();
  const db = handle.db;
  if (opts.seed) opts.seed(db);

  const userServers: McpServerSource[] =
    opts.settings?.mcpServers.map((s) => ({
      ...s,
      source: "user-settings" as const,
      sourcePath: opts.settings!.path,
    })) ?? [];
  const config: ConfigSnapshot = {
    claudeMdFiles: opts.claudeMdFiles ?? [],
    settings: opts.settings ?? null,
    mcpServers: opts.mcpServers ?? userServers,
    skills: opts.skills ?? [],
    plugins: opts.plugins ?? [],
  };

  const ctx: DetectorContext = {
    events: { db },
    config,
    now: opts.now ?? new Date(),
    recentDismissals: opts.recentDismissals ?? new Set(),
    daysOfDataAvailable: opts.daysOfDataAvailable ?? 30,
  };

  return {
    ctx,
    db,
    cleanup: () => handle.close(),
  };
}

/** Insert an api_request event with the given timestamp + token counts. */
export function seedApiRequest(
  db: Database,
  args: {
    eventId: string;
    timestamp: string;
    sessionId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    model?: string;
    isSidechain?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO events (event_id, schema_version, timestamp_iso, user_id, machine_id, provider, session_id, message_id, event_type, payload_json)
     VALUES (?, 2, ?, 'u', 'm', 'claude_code', ?, NULL, 'api_request', ?)`,
  ).run(
    args.eventId,
    args.timestamp,
    args.sessionId ?? "s1",
    JSON.stringify({
      model: args.model ?? "claude-opus",
      input_tokens: args.inputTokens ?? 100,
      output_tokens: args.outputTokens ?? 50,
      cache_creation_tokens: args.cacheCreationTokens ?? 0,
      cache_read_tokens: args.cacheReadTokens ?? 0,
      stop_reason: "end_turn",
      cwd: "/tmp",
      git_branch: null,
      parent_uuid: null,
      is_sidechain: args.isSidechain === true,
    }),
  );
}

/** Insert a tool_use event tagged to an MCP server. */
export function seedMcpToolUse(
  db: Database,
  args: { eventId: string; timestamp: string; serverName: string; toolName?: string },
): void {
  const tool = args.toolName ?? `mcp__${args.serverName}__some_tool`;
  db.prepare(
    `INSERT INTO events (event_id, schema_version, timestamp_iso, user_id, machine_id, provider, session_id, message_id, event_type, payload_json)
     VALUES (?, 1, ?, 'u', 'm', 'claude_code', 's1', NULL, 'tool_use', ?)`,
  ).run(
    args.eventId,
    args.timestamp,
    JSON.stringify({
      tool_name: tool,
      tool_use_id: args.eventId,
      mcp_server_name: args.serverName,
      parent_event_id: "p",
    }),
  );
}

/**
 * Insert an api_error event for retry-storm tests. `timestamp` should be
 * ISO; `retryAttempt` defaults to 1 (first retry). Use `maxRetries` +
 * `retryAttempt = maxRetries` to mark a retry-cap hit.
 */
export function seedApiError(
  db: Database,
  args: {
    eventId: string;
    timestamp: string;
    sessionId?: string;
    retryAttempt?: number;
    maxRetries?: number;
    retryInMs?: number;
    level?: string;
  },
): void {
  db.prepare(
    `INSERT INTO events (event_id, schema_version, timestamp_iso, user_id, machine_id, provider, session_id, message_id, event_type, payload_json)
     VALUES (?, 2, ?, 'u', 'm', 'claude_code', ?, NULL, 'api_error', ?)`,
  ).run(
    args.eventId,
    args.timestamp,
    args.sessionId ?? "s1",
    JSON.stringify({
      retry_attempt: args.retryAttempt ?? 1,
      max_retries: args.maxRetries ?? 10,
      retry_in_ms: args.retryInMs ?? 500,
      level: args.level ?? "error",
    }),
  );
}

/** Insert an auto_compact event for compact-overuse tests. */
export function seedAutoCompact(
  db: Database,
  args: {
    eventId: string;
    timestamp: string;
    sessionId?: string;
    preTokens?: number;
    postTokens?: number;
    trigger?: string;
  },
): void {
  db.prepare(
    `INSERT INTO events (event_id, schema_version, timestamp_iso, user_id, machine_id, provider, session_id, message_id, event_type, payload_json)
     VALUES (?, 2, ?, 'u', 'm', 'claude_code', ?, NULL, 'auto_compact', ?)`,
  ).run(
    args.eventId,
    args.timestamp,
    args.sessionId ?? "s1",
    JSON.stringify({
      trigger: args.trigger ?? "auto",
      pre_tokens: args.preTokens ?? 150_000,
      post_tokens: args.postTokens ?? 20_000,
      duration_ms: 5000,
      pre_compact_tool_count: 6,
    }),
  );
}

/** Insert a `skill_activated` event (used by the unused-skill detector tests). */
export function seedSkillActivated(
  db: Database,
  args: { eventId: string; timestamp: string; skillName: string },
): void {
  db.prepare(
    `INSERT INTO events (event_id, schema_version, timestamp_iso, user_id, machine_id, provider, session_id, message_id, event_type, payload_json)
     VALUES (?, 1, ?, 'u', 'm', 'claude_code', 's1', NULL, 'skill_activated', ?)`,
  ).run(
    args.eventId,
    args.timestamp,
    JSON.stringify({ skill_name: args.skillName }),
  );
}

/** Build a minimal ClaudeSettings with the listed MCP servers. */
export function fakeSettings(args: {
  filePath: string;
  servers: { name: string; disabled?: boolean }[];
}): ClaudeSettings {
  // Touch mtime to be older than the recent-install grace period (>7 days).
  fs.writeFileSync(args.filePath, JSON.stringify({}));
  const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(args.filePath, eightDaysAgo, eightDaysAgo);
  const mcpServers: McpServerConfig[] = args.servers.map((s) => ({
    name: s.name,
    config: { command: "x" },
    disabled: s.disabled ?? false,
  }));
  return {
    path: args.filePath,
    raw: { mcpServers: Object.fromEntries(mcpServers.map((s) => [s.name, s.config])) },
    hooks: [],
    mcpServers,
  };
}

/**
 * Build a McpServerSource list from compact tuples, writing each `sourcePath`
 * to disk so the detector's freshly-installed mtime check works correctly.
 */
export function fakeMcpServers(
  args: { name: string; source: McpServerSource["source"]; sourcePath: string; disabled?: boolean }[],
): McpServerSource[] {
  for (const a of args) {
    fs.mkdirSync(path.dirname(a.sourcePath), { recursive: true });
    if (!fs.existsSync(a.sourcePath)) fs.writeFileSync(a.sourcePath, "{}");
    // Make the source file look 30 days old by default; recent-install grace expects < 7 days.
    const thirtyDaysAgo = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(a.sourcePath, thirtyDaysAgo, thirtyDaysAgo);
  }
  return args.map((a) => ({
    name: a.name,
    config: { command: "x" },
    disabled: a.disabled ?? false,
    source: a.source,
    sourcePath: a.sourcePath,
  }));
}

/** Build a Skill record for tests; mtime defaults to 30 days ago (past grace period). */
export function fakeSkill(args: { name: string; path: string; daysOld?: number }): Skill {
  const mtimeMs = Date.now() - (args.daysOld ?? 30) * 24 * 60 * 60 * 1000;
  return {
    name: args.name,
    path: args.path,
    skillMdPath: `${args.path}/SKILL.md`,
    description: null,
    frontmatterTokens: 50,
    bodyTokens: 200,
    mtimeMs,
  };
}

/**
 * Narrow a detector's `Finding | Finding[] | null` return to a single
 * Finding for tests of aggregate detectors. Throws if the detector
 * returned an array or null — call only when the test already asserted
 * a non-null single-finding outcome (e.g., right after `expect(r).not.toBeNull()`).
 */
export function singleFinding(result: Finding | Finding[] | null): Finding {
  if (result === null) throw new Error("singleFinding: detector returned null");
  if (Array.isArray(result)) {
    throw new Error(`singleFinding: detector returned an array of ${result.length}`);
  }
  return result;
}

/** Build a ClaudeMdFile record. `wordCount` drives detector severity. */
export function fakeClaudeMd(args: { path: string; wordCount: number }): ClaudeMdFile {
  // Touch the file so the strategy's mtime check passes.
  fs.mkdirSync(path.dirname(args.path), { recursive: true });
  fs.writeFileSync(args.path, "x");
  const fortyDaysAgo = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(args.path, fortyDaysAgo, fortyDaysAgo);
  // Canonicalize to match what readClaudeMdFiles produces in production.
  const canon = fs.realpathSync(args.path);
  return {
    path: canon,
    content: "x".repeat(args.wordCount * 5),
    wordCount: args.wordCount,
    estimatedTokens: Math.round(args.wordCount * 1.33),
    imports: [],
  };
}
