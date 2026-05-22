/**
 * Plouto enforcement-layer configuration.
 *
 * Source order:
 *   1. PLOUTO_API_URL + PLOUTO_TOKEN env vars (recommended, set once
 *      in the user's shell or in ~/.claude/settings.json:env).
 *   2. ~/.plouto/config.json   { api_url, token }
 *
 * Either source must yield both fields for the sync to run. Missing
 * config is *not* an error — the SessionStart hook is best-effort and
 * silently skips when Plouto isn't configured (so the plugin doesn't
 * break Claude Code for users who haven't connected yet).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PloutoConfig {
  apiUrl: string;
  token: string;
  source: "env" | "file";
}

const DEFAULT_API_URL = "https://team.plouto.ai";

/**
 * Returns a fully-populated config or null when neither source has
 * both ``api_url`` (or a default) and ``token``.
 */
export function loadPloutoConfig(): PloutoConfig | null {
  const envToken = process.env.PLOUTO_TOKEN?.trim();
  if (envToken) {
    return {
      apiUrl: (process.env.PLOUTO_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, ""),
      token: envToken,
      source: "env",
    };
  }

  // Fallback: read ~/.plouto/config.json. Errors are swallowed —
  // SessionStart enforcement is non-blocking by design.
  try {
    const path = join(homedir(), ".plouto", "config.json");
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as { api_url?: string; token?: string };
    if (data.token && typeof data.token === "string") {
      return {
        apiUrl: (data.api_url?.trim() || DEFAULT_API_URL).replace(/\/+$/, ""),
        token: data.token.trim(),
        source: "file",
      };
    }
  } catch {
    // No file or invalid JSON — fall through.
  }

  return null;
}
