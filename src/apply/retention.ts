/**
 * Backup retention. Operations older than `retentionDays` have their backups
 * pruned; the operation row stays so the audit trail is preserved.
 *
 * Runs automatically once per `boost` invocation if the last prune was > 7
 * days ago (tracked in `prune_state`).
 */
import * as fs from "node:fs";
import type { Database as BunDatabase } from "bun:sqlite";
import { DAY_MS } from "../time.ts";

const PRUNE_INTERVAL_MS = 7 * DAY_MS;

export type PruneSummary = {
  pruned: number;
  freedBytes: number;
};

export function pruneOldBackups(db: BunDatabase, retentionDays: number = 90): PruneSummary {
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
  const rows = db
    .query<
      { operation_id: string; backup_ref_json: string },
      [string]
    >(
      `SELECT operation_id, backup_ref_json
       FROM operations
       WHERE applied_at_iso < ?`,
    )
    .all(cutoff);

  let pruned = 0;
  let freed = 0;
  for (const row of rows) {
    let ref: { path: string };
    try {
      ref = JSON.parse(row.backup_ref_json);
    } catch {
      continue;
    }
    if (!ref.path) continue;
    if (!fs.existsSync(ref.path)) continue;
    try {
      const st = fs.statSync(ref.path);
      freed += st.size;
      fs.unlinkSync(ref.path);
      pruned += 1;
    } catch {
      // ignore — best effort
    }
    // Also remove sidecar metadata.
    const sidecar = `${ref.path}.meta.json`;
    if (fs.existsSync(sidecar)) {
      try {
        fs.unlinkSync(sidecar);
      } catch {
        // ignore
      }
    }
  }
  recordPrune(db);
  return { pruned, freedBytes: freed };
}

/** Run prune iff > 7 days since last; idempotent. */
export function pruneIfDue(db: BunDatabase, retentionDays: number = 90): PruneSummary | null {
  const row = db.query<{ last_pruned_at_iso: string | null }, []>(
    `SELECT last_pruned_at_iso FROM prune_state WHERE id = 1`,
  ).get();
  if (row?.last_pruned_at_iso) {
    const last = Date.parse(row.last_pruned_at_iso);
    if (Number.isFinite(last) && Date.now() - last < PRUNE_INTERVAL_MS) return null;
  }
  return pruneOldBackups(db, retentionDays);
}

function recordPrune(db: BunDatabase): void {
  db.prepare(
    `INSERT INTO prune_state (id, last_pruned_at_iso) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_pruned_at_iso = excluded.last_pruned_at_iso`,
  ).run(new Date().toISOString());
}
