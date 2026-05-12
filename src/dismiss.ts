/** Dismissal tracking — strategies the user explicitly hid for ~30 days. */
import type { Database as BunDatabase } from "bun:sqlite";
import { DAY_MS } from "./time.ts";

const DEFAULT_DAYS = 30;

export function dismiss(db: BunDatabase, strategyId: string, days: number = DEFAULT_DAYS): void {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * DAY_MS);
  db.prepare(
    `INSERT INTO dismissed (strategy_id, dismissed_at, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(strategy_id) DO UPDATE SET
       dismissed_at = excluded.dismissed_at,
       expires_at   = excluded.expires_at`,
  ).run(strategyId, now.toISOString(), expiresAt.toISOString());
}

export function activeDismissals(db: BunDatabase, now: Date = new Date()): Set<string> {
  const rows = db
    .query<{ strategy_id: string }, [string]>(
      `SELECT strategy_id FROM dismissed WHERE expires_at > ?`,
    )
    .all(now.toISOString());
  return new Set(rows.map((r) => r.strategy_id));
}
