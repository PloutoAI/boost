/**
 * High-level orchestration. Initializes the DB, ingests JSONL, runs detectors.
 * The CLI calls this once and then dispatches output (TUI, JSON, check).
 */
import type { Database as BunDatabase } from "bun:sqlite";
import { LoopDatabase } from "./db.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { ingestAll, type IngestSummary } from "./data/jsonl-ingest.ts";
import { runDetectors, type RunnerResult } from "./runner.ts";
import { rankFindings, totalClearWinsSavings } from "./ranker.ts";
import { pruneIfDue } from "./apply/retention.ts";

export type OrchestrateOptions = {
  showAll?: boolean;
  cwd?: string;
  warn?: (msg: string) => void;
};

export type OrchestrateResult = {
  db: BunDatabase;
  ingest: IngestSummary;
  runner: RunnerResult;
  totalSavingsPct: number;
};

/** End-to-end: open DB, ingest, run, rank. Result is freshly constructed. */
export function bootstrap(opts: OrchestrateOptions = {}): OrchestrateResult {
  const warn = opts.warn ?? (() => {});
  const handle = LoopDatabase.open();
  const db = handle.db;
  const identity = loadOrCreateIdentity();

  const ingest = ingestAll(
    {
      db,
      userId: identity.user_id,
      machineId: identity.machine_id,
      provider: "claude_code",
    },
    { warn },
  );

  const rawRunner = runDetectors(db, { showAll: opts.showAll, cwd: opts.cwd, warn });
  const runner: RunnerResult = {
    ...rawRunner,
    findings: rankFindings(rawRunner.findings),
  };

  // Backup retention is best-effort; surface failures via the warn callback so
  // a chronically-failing prune (disk full, perms) doesn't stay silent.
  try {
    pruneIfDue(db);
  } catch (err) {
    warn(`backup retention skipped: ${(err as Error).message}`);
  }

  return {
    db,
    ingest,
    runner,
    totalSavingsPct: totalClearWinsSavings(runner.findings),
  };
}
