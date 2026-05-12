/**
 * JSONL discovery — walk `${CLAUDE_CONFIG_DIR}/projects/` and return absolute
 * file paths sorted by mtime ascending.
 *
 * Path safety: each candidate is verified to live under the canonical
 * `claudeHome()`. Symlinks are skipped (with a warning) per threat model §C3.1.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { claudeHome } from "../paths.ts";

/** Hard cap to defend against `~/.claude/projects/` containing thousands of files. */
const MAX_FILES = 10_000;

/** Skip files smaller than this (truncated writes / placeholders). */
const MIN_BYTES = 100;

export type DiscoveredFile = {
  path: string;
  size: number;
  mtimeMs: number;
};

/**
 * Discover all JSONL session logs under known Claude Code source directories:
 *
 *   - `${CLAUDE_CONFIG_DIR}/projects/**`        (the canonical session log path)
 *   - `${CLAUDE_CONFIG_DIR}/transcripts/**`     (an additional source seen on
 *     some Claude Code versions per tokscale's reading; best-effort, may not
 *     exist on all installs)
 *
 * Each candidate directory is canonicalized and acts as its own allowed
 * root — files outside the corresponding root are rejected.
 */
const SOURCE_SUBDIRS = ["projects", "transcripts"] as const;

export function discoverJsonl(opts: { warn?: (msg: string) => void } = {}): DiscoveredFile[] {
  const warn = opts.warn ?? (() => {});
  const out: DiscoveredFile[] = [];

  for (const sub of SOURCE_SUBDIRS) {
    if (out.length >= MAX_FILES) break;
    const dir = path.join(claudeHome(), sub);
    if (!fs.existsSync(dir)) continue;
    const dirCanon = realpathOrSelf(dir);
    walkDir(dir, (entry, full) => {
      if (out.length >= MAX_FILES) return;
      if (!entry.isFile() || !full.endsWith(".jsonl")) return;
      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(full);
      } catch {
        return;
      }
      if (lst.isSymbolicLink()) {
        warn(`skipping symlinked JSONL: ${full}`);
        return;
      }
      const canon = realpathOrSelf(full);
      if (!canon.startsWith(dirCanon + path.sep) && canon !== dirCanon) {
        warn(`skipping JSONL outside ~/.claude/${sub}/: ${full}`);
        return;
      }
      if (lst.size < MIN_BYTES) return;
      out.push({ path: full, size: lst.size, mtimeMs: lst.mtimeMs });
    });
  }

  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  if (out.length >= MAX_FILES) {
    warn(`discovered ≥ ${MAX_FILES} JSONL files; processing the most-recent batch only`);
  }
  return out;
}

function walkDir(dir: string, visit: (entry: fs.Dirent, full: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip symlinked directories.
      try {
        const lst = fs.lstatSync(full);
        if (lst.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      walkDir(full, visit);
    } else {
      visit(entry, full);
    }
  }
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
