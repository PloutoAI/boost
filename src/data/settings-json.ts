/**
 * Read and parse `~/.claude/settings.json` (which may be JSONC).
 *
 * Returns `null` (with a warning) if the file is missing or malformed —
 * never throws, never crashes the run. Refuses prototype-pollution payloads
 * by using `jsonc-parser` (which doesn't merge) and never spreading user data.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { claudeHome } from "../paths.ts";
import { isObject } from "./jsonl-payload.ts";

export type McpServerConfig = {
  name: string;
  config: Record<string, unknown>;
  disabled: boolean;
};

export type ClaudeSettings = {
  /** Canonical absolute path the settings were read from. */
  path: string;
  raw: Record<string, unknown>;
  hooks: HookList[];
  mcpServers: McpServerConfig[];
};

export type HookList = {
  /** e.g. `"UserPromptSubmit"`, `"SessionStart"`. */
  event: string;
  entries: unknown[];
};

export type ReadResult = {
  settings: ClaudeSettings | null;
  warning?: string;
};

/** Read `${CLAUDE_CONFIG_DIR}/settings.json`. */
export function readSettings(): ReadResult {
  const file = path.join(claudeHome(), "settings.json");
  if (!fs.existsSync(file)) {
    return { settings: null, warning: `${file} not found — has Claude Code been run on this machine?` };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { settings: null, warning: `couldn't read ${file}: ${(err as Error).message}` };
  }
  const errors: { error: number; offset: number }[] = [];
  const parsed = parseJsonc(raw, errors as never[], { allowTrailingComma: true });
  if (errors.length > 0 || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { settings: null, warning: `${file} contains invalid JSON; skipping config-aware checks` };
  }
  // Recursive prototype-key strip — defends against nested
  // {"mcpServers": {"foo": {"__proto__": {...}}}} payloads in case any
  // future code spreads/Object.assigns on user data.
  const obj = sanitizeProtoKeys(parsed) as Record<string, unknown>;

  return {
    settings: {
      path: file,
      raw: obj,
      hooks: extractHooks(obj),
      mcpServers: extractMcpServers(obj),
    },
  };
}

const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Walk an arbitrary parsed-JSON value and remove any prototype-key entries
 * at every depth. Returns the same node mutated in place; safe because
 * `jsonc-parser` returns fresh objects.
 *
 * Exported so other parsers (`mcp-sources.ts` etc.) can apply the same
 * defense-in-depth to user-controlled JSON they read.
 */
export function sanitizeProtoKeys(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (const child of node) sanitizeProtoKeys(child);
    return node;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (PROTO_KEYS.has(key)) {
        delete o[key];
        continue;
      }
      sanitizeProtoKeys(o[key]);
    }
    return o;
  }
  return node;
}

function extractHooks(o: Record<string, unknown>): HookList[] {
  const out: HookList[] = [];
  const hooks = o["hooks"];
  if (!isObject(hooks)) return out;
  for (const [event, val] of Object.entries(hooks)) {
    if (Array.isArray(val)) {
      out.push({ event, entries: val });
    }
  }
  return out;
}

function extractMcpServers(o: Record<string, unknown>): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  const servers = o["mcpServers"];
  if (!isObject(servers)) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    if (!isObject(cfg)) continue;
    const disabled = cfg["disabled"] === true;
    out.push({ name, config: cfg, disabled });
  }
  return out;
}

/** Normalize an MCP server name for comparison (lowercase, hyphens collapsed). */
export function normalizeServerName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-").replace(/-+/g, "-");
}
