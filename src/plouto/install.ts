/**
 * ``boost install`` — one-line setup for the Plouto enforcement layer.
 *
 * Wraps the three things every engineer needs into a single invocation:
 *
 *   1. Register the boost marketplace (``extraKnownMarketplaces``)
 *   2. Enable the plouto plugin (``enabledPlugins["plouto@boost"]``)
 *   3. Set PLOUTO_TOKEN + PLOUTO_API_URL in the settings ``env`` block
 *
 * Two modes:
 *
 *   Default (per-user)     → writes ``~/.claude/settings.json``
 *   --managed (org-wide)   → writes the OS-specific managed settings path,
 *                            usually requires sudo. Admins ship this via
 *                            MDM / a bootstrap script.
 *
 * Critically: settings.json files are *merged*, never overwritten.
 * Engineers (or admins) have other config in there — theme, OTEL
 * exporter env, permissions allow lists — that the install command
 * must preserve. We use ``jsonc-parser``'s modify API which is
 * comment-preserving for JSONC inputs.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

import { runOAuthLogin } from "./oauth.ts";

const MARKETPLACE_KEY = "boost";
const PLUGIN_KEY = "plouto@boost";
const GITHUB_REPO = "PloutoAI/boost";

export interface InstallOptions {
  token?: string;
  apiUrl?: string;
  managed?: boolean;
  debug?: boolean;
  /**
   * When ``--token`` is not provided, default to running the OAuth
   * localhost-redirect flow so the engineer never copy-pastes a token.
   * Set to false on CI / non-interactive contexts where opening a
   * browser doesn't make sense.
   */
  noAuth?: boolean;
}

export interface InstallResult {
  path: string;
  created: boolean;
  managed: boolean;
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const apiUrl = (opts.apiUrl ?? "https://team.plouto.ai").replace(/\/+$/, "");

  let token = opts.token;
  if (!token) {
    if (opts.noAuth) {
      throw new Error(
        "PLOUTO_TOKEN required. Pass --token <plto_…>, or drop --no-auth to " +
        "run the OAuth login flow.",
      );
    }
    // Browser-based OAuth: opens a tab, completes login on Plouto,
    // captures the redirected token on a localhost port. Same pattern
    // gh / gcloud / fly use.
    const result = await runOAuthLogin({ apiUrl });
    token = result.token;
  }

  const path = opts.managed ? managedSettingsPath() : userSettingsPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const existed = existsSync(path);
  const before = existed ? readFileSync(path, "utf8") : "{}";

  // Validate the file we're merging into. jsonc-parser tolerates
  // comments + trailing commas but a totally invalid JSON file we
  // shouldn't silently destroy.
  const parsed = parse(before, [], { allowTrailingComma: true });
  if (parsed === undefined && before.trim().length > 0) {
    throw new Error(
      `${path} exists but isn't valid JSON. Fix or move it before re-running install.`,
    );
  }

  // Build the four edits we want to land. Each one is a (path, value)
  // tuple jsonc-parser's modify() applies as a localized patch — so
  // surrounding keys, comments, and formatting are preserved.
  type Patch = { path: (string | number)[]; value: unknown };
  const patches: Patch[] = [
    {
      path: ["extraKnownMarketplaces", MARKETPLACE_KEY],
      value: { source: { source: "github", repo: GITHUB_REPO } },
    },
    {
      path: ["enabledPlugins", PLUGIN_KEY],
      value: true,
    },
    {
      path: ["env", "PLOUTO_TOKEN"],
      value: opts.token,
    },
    {
      path: ["env", "PLOUTO_API_URL"],
      value: apiUrl,
    },
  ];

  let next = before;
  for (const patch of patches) {
    const edits = modify(next, patch.path, patch.value, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    next = applyEdits(next, edits);
  }

  // Ensure trailing newline — friendlier for diff tools.
  if (!next.endsWith("\n")) next += "\n";

  writeFileSync(path, next, { encoding: "utf8", mode: 0o600 });

  return { path, created: !existed, managed: !!opts.managed };
}

// ---------------------------------------------------------------------------
// OS paths
// ---------------------------------------------------------------------------

function userSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function managedSettingsPath(): string {
  switch (platform()) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "win32":
      // Same shape as the Linux/Mac file but admins also have a
      // registry-based path; the file path is documented + sufficient.
      return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}
