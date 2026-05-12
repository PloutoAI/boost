/**
 * MCP server discovery across all v0.1-known sources:
 *
 *  1. `${CLAUDE_CONFIG_DIR}/settings.json`             — `mcpServers` key
 *  2. `<cwd>/.mcp.json`                                — Claude Code project file
 *  3. `<ancestor>/.mcp.json` walking up to home          (covers monorepos)
 *  4. `${CLAUDE_CONFIG_DIR}/plugins/<plugin>/.mcp.json` — plugin-bundled servers
 *  5. `${CLAUDE_CONFIG_DIR}/plugins/<plugin>/plugin.json` (if it has `mcpServers`)
 *
 * Merging rules:
 * - User settings.json wins on conflicts (last loaded). Project files override
 *   plugins. Each server records its `source` so the detector and TUI can
 *   show *where* a server came from.
 * - "disabled" stays sticky — if any source disables a server, it's disabled.
 *
 * Limitations (v0.1):
 * - We don't follow plugin-marketplace registries.
 * - We don't read VSCode/Cursor MCP configs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { claudeHome } from "../paths.ts";
import { sanitizeProtoKeys } from "./settings-json.ts";
import type { McpServerConfig } from "./settings-json.ts";

/** Where a configured MCP server came from. Surfaced in evidence + TUI. */
export type McpSourceKind =
  | "user-settings"
  | "project-mcp-json"
  | "plugin-mcp-json"
  | "plugin-manifest";

export type McpServerSource = McpServerConfig & {
  /** Lowest-precedence to highest-precedence: plugin-* < project-mcp-json < user-settings. */
  source: McpSourceKind;
  /** File this server was declared in (canonical). */
  sourcePath: string;
};

export type DiscoveryOptions = {
  /** Project working directory; we walk parents up to `$HOME`. */
  cwd?: string;
  /** Already-merged user-settings entries (avoids re-reading). */
  userSettings?: McpServerConfig[];
  /** Settings.json path, if known — for sourcePath reporting. */
  userSettingsPath?: string | null;
};

/**
 * Discover MCP servers from every known source. Returns one entry per server,
 * with conflicts resolved by precedence (user-settings > project > plugin).
 */
export function discoverMcpServers(opts: DiscoveryOptions = {}): McpServerSource[] {
  const home = process.env["HOME"] ?? "";
  const all: McpServerSource[] = [];

  // 1. Plugins (lowest precedence). Real-world Claude Code installs nest
  //    plugins as: `plugins/marketplaces/<m>/(plugins|external_plugins)/<p>/.mcp.json`,
  //    so a flat read isn't enough — walk the tree (capped depth + count).
  for (const mcpFile of findPluginMcpFiles()) {
    all.push(...readMcpJson(mcpFile, "plugin-mcp-json"));
  }

  // 2. Project `.mcp.json`, walking up.
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  let dir = cwd;
  for (let i = 0; i < 32; i++) {
    const candidate = path.join(dir, ".mcp.json");
    all.push(...readProjectMcpJson(candidate));
    if (dir === home || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }

  // 3. User settings.json (highest precedence).
  if (opts.userSettings && opts.userSettingsPath) {
    for (const s of opts.userSettings) {
      all.push({ ...s, source: "user-settings", sourcePath: opts.userSettingsPath });
    }
  }

  // Merge by name. Later entries (higher precedence in iteration order above)
  // overwrite earlier ones, except `disabled: true` is sticky.
  const merged = new Map<string, McpServerSource>();
  for (const entry of all) {
    const existing = merged.get(entry.name);
    if (!existing) {
      merged.set(entry.name, entry);
      continue;
    }
    const disabled = existing.disabled || entry.disabled;
    merged.set(entry.name, { ...entry, disabled });
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Cap the plugin walk so a marketplace with thousands of repos can't pin us. */
const MAX_PLUGIN_DEPTH = 5;
const MAX_PLUGIN_FILES = 200;

/**
 * Walk `~/.claude/plugins/` looking for `.mcp.json` files. Skips dot-dirs
 * we know are noise (`.git`, `.cache`, `node_modules`) and refuses symlinks.
 */
function findPluginMcpFiles(): string[] {
  const root = path.join(claudeHome(), "plugins");
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  walk(root, 0);
  return out;

  function walk(dir: string, depth: number): void {
    if (depth > MAX_PLUGIN_DEPTH) return;
    if (out.length >= MAX_PLUGIN_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_PLUGIN_FILES) return;
      const full = path.join(dir, e.name);
      // Skip symlinks defensively (we'd resolve via realpath but skipping
      // avoids any chance of symlink loops).
      try {
        const lst = fs.lstatSync(full);
        if (lst.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (e.isDirectory()) {
        // Skip noise / VCS / cache dirs.
        if (e.name === ".git" || e.name === ".cache" || e.name === "node_modules") continue;
        walk(full, depth + 1);
      } else if (e.isFile() && (e.name === ".mcp.json" || e.name === "plugin.json")) {
        // plugin.json is included because some plugins declare `mcpServers`
        // there instead of (or in addition to) `.mcp.json`. readMcpJson is
        // a no-op for files that don't have an `mcpServers` key.
        out.push(full);
      }
    }
  }
}

function readProjectMcpJson(filePath: string): McpServerSource[] {
  return readMcpJson(filePath, "project-mcp-json");
}

function readMcpJson(filePath: string, source: McpSourceKind): McpServerSource[] {
  if (!fs.existsSync(filePath)) return [];
  let canon: string;
  try {
    canon = fs.realpathSync(filePath);
  } catch {
    return [];
  }
  let raw: string;
  try {
    raw = fs.readFileSync(canon, "utf8");
  } catch {
    return [];
  }
  const errors: { error: number; offset: number }[] = [];
  const parsed = parseJsonc(raw, errors as never[], { allowTrailingComma: true });
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const sanitized = sanitizeProtoKeys(parsed) as Record<string, unknown>;
  const servers = sanitized["mcpServers"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];

  const out: McpServerSource[] = [];
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
    const config = cfg as Record<string, unknown>;
    out.push({
      name,
      config,
      disabled: config["disabled"] === true,
      source,
      sourcePath: canon,
    });
  }
  return out;
}

