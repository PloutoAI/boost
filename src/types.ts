/**
 * Core types shared across boost. No logic — this is the contract.
 *
 * Discriminated unions use a `kind` tag and consumers should use
 * `assertNever` (below) at the catch-all branch so adding a new variant
 * fails type-checking until every handler is updated.
 */

/** Severity of a finding. Consumed by the ranker and the TUI badge. */
export type Severity = "high" | "medium" | "low";

/** Two-axis classification simplified to two visible buckets. */
export type Category = "clear-wins" | "trade-offs";

/**
 * A finding produced by a detector. Findings are pure data; they carry
 * everything the TUI/JSON output needs to render the row.
 */
export type Finding = {
  /** e.g. `"unused-mcp-disable"` */
  strategyId: string;
  /** Bumped if the rule's logic changes; used for replay invalidation. */
  strategyVersion: number;
  category: Category;
  severity: Severity;
  /** Human-readable headline, e.g. `"Disable 3 unused MCP servers"`. */
  title: string;
  /** Names referenced by the fix; surfaced in detail view and JSON. */
  affectedItems: string[];
  /** Conservative point estimate for ranking; ranges in copy. */
  estimatedTokensSavedPerRequest: number;
  /** Null when we don't have enough data (cold-start). */
  estimatedPercentOfWeeklyUsage: number | null;
  evidence: Evidence;
  /**
   * Optional list of fixes. Findings without fixes are *advisory* — they
   * surface a recommendation but boost has no automated change to make.
   * The TUI hides Apply on advisory findings and excludes them from
   * `tidy-ups`. Acceptable for: model-mix recommendations, runtime-
   * injected MCP gaps, anything that's "you should know" rather than
   * "boost will do this for you".
   */
  fixes?: NonEmpty<Fix>;
};

/** A non-empty array — TypeScript enforces the first element exists. */
export type NonEmpty<T> = readonly [T, ...T[]];

/** Behavioral evidence behind a finding — what we observed and over what window. */
export type Evidence = {
  observedAtIso: string;
  windowDays: number;
  /** Free-form structured evidence; the TUI's `e` view dumps this. */
  signals: Record<string, unknown>;
  humanReadable: string;
};

/** Discriminated union of fix payloads. Add cases via the union, not casts. */
export type Fix =
  | { kind: "modify-file"; payload: ModifyFilePayload }
  | { kind: "modify-settings-key"; payload: ModifySettingsKeyPayload }
  | { kind: "archive-directory"; payload: ArchiveDirectoryPayload };

/** Replace the entire contents of a file with `newContent`. */
export type ModifyFilePayload = {
  /** Canonicalized absolute path; verified within an allowed root. */
  filePath: string;
  newContent: string;
  /**
   * When true, the static `newContent` is a placeholder — apply must be
   * driven through `--content-from-stdin` (a plugin skill supplying real
   * LLM-synthesized content). The CLI refuses to apply without stdin,
   * and `apply --all` skips this finding entirely with a stderr note.
   *
   * Set this when the *only honest fix* requires language synthesis (e.g.,
   * `claude-md-bloat` — a static stub replacement is theater, not a fix).
   */
  requiresContent?: boolean;
};

/** Set a single JSON path inside a settings file. */
export type ModifySettingsKeyPayload = {
  filePath: string;
  /** Dot-notated, e.g. `"mcpServers.github-mcp.disabled"`. */
  jsonPath: string;
  newValue: unknown;
};

/** Move a directory tree from `fromPath` to `toPath`. */
export type ArchiveDirectoryPayload = {
  fromPath: string;
  toPath: string;
};

/**
 * Recorded outcome of an apply. The combination of `beforeHash`/`afterHash`
 * + `backupRef` is what `revert` reconstructs the prior state from.
 */
export type Operation = {
  operationId: string;
  strategyId: string;
  strategyVersion: number;
  appliedAtIso: string;
  revertedAtIso: string | null;
  source: "built-in";
  beforeHash: string;
  afterHash: string;
  backupRef: BackupRef;
  predictedSavingsPercent: number | null;
};

/**
 * Pointer into `~/.boost/backups/`. Self-contained: every field needed to
 * verify integrity and restore is inline; no sidecar files. `backupHash` is
 * sha256 of the backup file's contents at write time; revert verifies it.
 */
export type BackupRef =
  | {
      kind: "file";
      /** Absolute path under `~/.boost/backups/`. */
      path: string;
      /** sha256 of the bytes at `path`, computed at backup time. */
      backupHash: string;
      /** Original file path the backup was taken from. */
      originalPath: string;
      /** POSIX mode bits to restore. */
      mode: number;
    }
  | {
      kind: "settings-key";
      path: string;
      backupHash: string;
      /** Settings file the key lives in. */
      originalPath: string;
      jsonPath: string;
    }
  | {
      kind: "directory";
      path: string;
      backupHash: string;
      originalPath: string;
    };

/** Compile-time exhaustiveness helper for switch/case on unions. */
export function assertNever(x: never, msg = "unreachable"): never {
  throw new Error(`${msg}: ${String(x)}`);
}
