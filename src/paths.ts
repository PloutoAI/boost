/**
 * Path module — every persistent location used by boost.
 *
 * Path safety: every returned path is canonicalized against `$BOOST_HOME` (or
 * `$HOME` for fallbacks). Returned paths must live inside an allowed root —
 * this module refuses to construct paths that would escape it.
 */
import { homedir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const HOME = homedir();

/** Resolve boost's data home, honoring `$BOOST_HOME` for tests. */
export function boostHome(): string {
  const override = process.env["BOOST_HOME"];
  return override && override.length > 0
    ? path.resolve(override)
    : path.join(HOME, ".boost");
}

/** Resolve Claude Code's config home, honoring `$CLAUDE_CONFIG_DIR`. */
export function claudeHome(): string {
  const override = process.env["CLAUDE_CONFIG_DIR"];
  return override && override.length > 0
    ? path.resolve(override)
    : path.join(HOME, ".claude");
}

/** Ensure `dir` exists with mode 0700; idempotent. */
function ensureDir(dir: string, mode: number = 0o700): string {
  fs.mkdirSync(dir, { recursive: true, mode });
  // recursive mkdir doesn't always reset mode on existing dirs; tighten if owned by us.
  try {
    const st = fs.statSync(dir);
    if ((st.mode & 0o777) !== mode && st.uid === process.getuid?.()) {
      fs.chmodSync(dir, mode);
    }
  } catch {
    // ignore — best effort
  }
  return dir;
}

/** Refuse paths that escape the boost home or the user's home. */
function assertSafe(p: string): string {
  const abs = path.resolve(p);
  const home = HOME;
  const bh = boostHome();
  if (!abs.startsWith(bh + path.sep) && abs !== bh && !abs.startsWith(home + path.sep) && abs !== home) {
    throw new Error(`refusing path outside allowed roots: ${abs}`);
  }
  return abs;
}

/** Path to the SQLite event database. */
export function dbPath(): string {
  ensureDir(boostHome());
  return assertSafe(path.join(boostHome(), "db.sqlite"));
}

/** Directory for file/dir backups. */
export function backupsDir(): string {
  return ensureDir(assertSafe(path.join(boostHome(), "backups")));
}

/** Per-operation JSON record directory. */
export function operationsDir(): string {
  return ensureDir(assertSafe(path.join(boostHome(), "operations")));
}

/** Anonymous identity file. */
export function identityPath(): string {
  ensureDir(boostHome());
  return assertSafe(path.join(boostHome(), "identity.json"));
}

/** Plain-text data schema version file. */
export function versionFile(): string {
  ensureDir(boostHome());
  return assertSafe(path.join(boostHome(), "version"));
}

/** Directory where archived skills are stored (outside `~/.claude/`). */
export function archivedSkillsDir(): string {
  return ensureDir(assertSafe(path.join(boostHome(), "archived-skills")));
}

/**
 * Pick the smallest allowed root that contains `canonTarget`. Returned
 * value is the realpath-canonicalized form, suitable for use as
 * `safeRoot` in `atomicWriteFile()` / `refuseSymlinkInAncestors()`.
 */
export function pickSafeRoot(canonTarget: string): string {
  const candidates = [claudeHome(), boostHome(), ...allowedWriteRoots()];
  for (const root of candidates) {
    let r: string;
    try {
      r = fs.realpathSync(root);
    } catch {
      r = path.resolve(root);
    }
    if (canonTarget === r || canonTarget.startsWith(r + path.sep)) return r;
  }
  throw new Error(`pickSafeRoot: no allowed root contains ${canonTarget}`);
}

/** Allowed write roots for fix payloads. Used by path-safety checks. */
export function allowedWriteRoots(): string[] {
  const roots = new Set<string>();
  roots.add(boostHome());
  roots.add(claudeHome());
  // Project cwd: limit to the user's home tree to avoid system locations.
  const cwd = path.resolve(process.cwd());
  if (cwd === HOME || cwd.startsWith(HOME + path.sep)) {
    roots.add(cwd);
  }
  return Array.from(roots);
}

/**
 * Canonicalize and verify a path is inside an allowed root. Resolves
 * symlinks via `realpathSync` so callers can't escape via a link.
 *
 * Returns the canonical path on success; throws on violation.
 */
export function assertWithinAllowedRoots(p: string, roots: string[] = allowedWriteRoots()): string {
  const abs = path.resolve(p);
  const canon = canonicalizeNonExistent(abs);
  for (const root of roots) {
    let rcanon: string;
    try {
      rcanon = fs.realpathSync(root);
    } catch {
      rcanon = path.resolve(root);
    }
    if (canon === rcanon || canon.startsWith(rcanon + path.sep)) {
      return canon;
    }
  }
  throw new Error(`path-safety: ${p} resolves outside allowed roots`);
}

/**
 * Walk up `abs` until a component exists; realpath that, then re-attach
 * the missing tail. Distinguishes "doesn't exist" from "outside roots".
 */
function canonicalizeNonExistent(abs: string): string {
  const parts: string[] = [];
  let cur = abs;
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      return parts.length === 0 ? real : path.join(real, ...parts.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      parts.push(path.basename(cur));
      const parent = path.dirname(cur);
      if (parent === cur) {
        // Hit the root with nothing existing — return as-is.
        return abs;
      }
      cur = parent;
    }
  }
}
