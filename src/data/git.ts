/**
 * Thin wrapper over `git log` for outcome attribution. Used by the
 * unshipped-cost detector to ask: "did any commits happen in this cwd
 * during/after this session?"
 *
 * Returns:
 *   - `null` if cwd isn't a git repo, the path doesn't exist, or git
 *     isn't available. The caller treats this as "untrackable" rather
 *     than "abandoned" — absence of evidence isn't evidence of absence.
 *   - `[]` if it IS a git repo but no commits landed in the window.
 *     This is the genuine "abandoned" signal.
 *   - `[hash, ...]` if commits exist in the window. Considered "shipped."
 *
 * Generous time bounds by design. We expand the window past the session
 * end so a squash-merge or quick post-session push still counts as
 * shipped. The user's commit might also predate the session end (work
 * landed mid-session). False negatives (missing real ship events) hurt
 * the user; false positives (counting unrelated commits as ship) just
 * undersell waste — preferred direction.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const GIT_TIMEOUT_MS = 3000;

export type CommitLookup = {
  cwd: string;
  /** ISO start, inclusive. Subject to the grace expansion below. */
  sinceIso: string;
  /** ISO end, exclusive. Subject to the grace expansion below. */
  untilIso: string;
};

/**
 * Return commit hashes in the given window, across all branches, in the
 * given cwd. Returns null if the cwd isn't a git repo or git isn't
 * available; returns [] if git ran but produced no commits.
 */
export function commitsInRange(args: CommitLookup): string[] | null {
  if (!fs.existsSync(args.cwd)) return null;
  const gitDir = findGitDir(args.cwd);
  if (!gitDir) return null;

  try {
    const out = execSync(
      `git log --all --since="${args.sinceIso}" --until="${args.untilIso}" --format=%H`,
      {
        cwd: args.cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        // Discard stderr to keep the audit quiet on benign warnings
        // (e.g. "warning: refname 'main' is ambiguous"). Real failures
        // throw and are caught below.
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

/**
 * Walk up from `cwd` looking for a `.git` directory or file. Mirrors
 * git's own discovery semantics so a session that worked in a
 * subdirectory of a repo still resolves to the repo root.
 */
function findGitDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  for (let i = 0; i < 32; i++) {
    const candidate = path.join(current, ".git");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
