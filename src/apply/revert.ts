/**
 * Revert engine. For every operation:
 *
 *   1. Hash the on-disk backup file and refuse if it differs from
 *      `backupRef.backupHash` (catches backup tampering for all 3 kinds).
 *   2. Restore.
 *   3. Verify post-restore state per kind:
 *        - file:        sha256(target) === beforeHash
 *        - settings-key: getJsonPath(target, jsonPath) deep-equals previousValue
 *        - directory:   shallow-hash(target) === beforeHash, AND the
 *                       moved-to archive is removed.
 *   4. Mark the operation reverted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { Database as BunDatabase } from "bun:sqlite";
import type { BackupRef, Operation } from "../types.ts";
import {
  hashDirectoryShallow,
  restoreFromBackup,
} from "./backup.ts";
import { archivedSkillsDir, boostHome } from "../paths.ts";

/** Look up an operation row and revert it. */
export async function revertOperation(db: BunDatabase, operationId: string): Promise<void> {
  const row = db
    .query<
      OperationRow,
      [string]
    >(
      `SELECT operation_id, strategy_id, strategy_version, applied_at_iso, reverted_at_iso,
              predicted_savings_pct, before_hash, after_hash, backup_ref_json, source
       FROM operations WHERE operation_id = ?`,
    )
    .get(operationId);
  if (!row) throw new Error(`unknown operation: ${operationId}`);
  if (row.reverted_at_iso) {
    return; // already reverted — no-op.
  }
  const backupRef = JSON.parse(row.backup_ref_json) as BackupRef;

  // Backup-tamper gate: implemented inside restoreFromBackup via verifyBackupIntegrity.
  const outcome = restoreFromBackup(backupRef);

  // Per-kind post-restore invariant.
  if (outcome.kind === "file") {
    if (outcome.postHash !== row.before_hash) {
      throw new Error(`post-restore hash mismatch on file ${backupRef.path}; refusing to mark reverted.`);
    }
  } else if (outcome.kind === "settings-key") {
    // Re-parse and confirm the value at jsonPath matches the recorded previousValue.
    if (backupRef.kind !== "settings-key") throw new Error("revert: outcome/ref kind mismatch");
    const txt = fs.readFileSync(backupRef.originalPath, "utf8");
    const parsed = parseJsonc(txt);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`post-restore parse failed for ${backupRef.originalPath}`);
    }
    const at = getDeep(parsed as Record<string, unknown>, backupRef.jsonPath);
    if (outcome.missing) {
      if (at !== undefined) {
        throw new Error(`post-restore: expected ${backupRef.jsonPath} missing, but got ${JSON.stringify(at)}`);
      }
    } else {
      if (!deepEqual(at, outcome.restoredValue)) {
        throw new Error(`post-restore: ${backupRef.jsonPath} mismatch (${JSON.stringify(at)} vs ${JSON.stringify(outcome.restoredValue)})`);
      }
    }
  } else if (outcome.kind === "directory") {
    if (outcome.shallowHash !== row.before_hash) {
      throw new Error(`post-restore directory shallow-hash mismatch for ${backupRef.path}.`);
    }
    if (backupRef.kind !== "directory") throw new Error("revert: outcome/ref kind mismatch");
    // Clean up the archive copy. Prefer the exact path recorded at apply
    // time; fall back to the legacy hash-scan for operations recorded
    // before `archivedToPath` was persisted.
    if (backupRef.archivedToPath) {
      removeArchivedCopy(backupRef.archivedToPath);
    } else {
      pruneArchivedCopies(backupRef.originalPath, row.after_hash);
    }
  }

  db.prepare(`UPDATE operations SET reverted_at_iso = ? WHERE operation_id = ?`).run(
    new Date().toISOString(),
    operationId,
  );
}

function getDeep(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj;
  for (const k of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao).sort();
  const kb = Object.keys(bo).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const k = ka[i]!;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Remove the exact archived copy recorded at apply time. Guarded: refuses
 * to delete anything outside `~/.boost/`. Best-effort.
 */
function removeArchivedCopy(archivedPath: string): void {
  const abs = path.resolve(archivedPath);
  const root = path.resolve(boostHome());
  if (abs !== root && !abs.startsWith(root + path.sep)) return; // never outside ~/.boost
  try {
    fs.rmSync(abs, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Legacy fallback for operations recorded before `archivedToPath` existed:
 * find archived copies whose shallow hash matches and remove them. Limits
 * search to `~/.boost/archived-skills/<base>-*`. Best-effort.
 */
function pruneArchivedCopies(originalPath: string, afterHash: string): void {
  const base = path.basename(originalPath);
  const archives = archivedSkillsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archives, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith(`${base}-`)) continue;
    const full = path.join(archives, e.name);
    try {
      const candidateHash = hashDirectoryShallow(full);
      if (candidateHash === afterHash) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

type OperationRow = {
  operation_id: string;
  strategy_id: string;
  strategy_version: number;
  applied_at_iso: string;
  reverted_at_iso: string | null;
  predicted_savings_pct: number | null;
  before_hash: string;
  after_hash: string;
  backup_ref_json: string;
  source: string;
};

export function recentOperations(db: BunDatabase, limit: number = 20): Operation[] {
  const rows = db
    .query<
      OperationRow,
      [number]
    >(
      `SELECT operation_id, strategy_id, strategy_version, applied_at_iso, reverted_at_iso,
              predicted_savings_pct, before_hash, after_hash, backup_ref_json, source
       FROM operations ORDER BY applied_at_iso DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map(rowToOperation);
}

function rowToOperation(row: OperationRow): Operation {
  return {
    operationId: row.operation_id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    appliedAtIso: row.applied_at_iso,
    revertedAtIso: row.reverted_at_iso,
    predictedSavingsPercent: row.predicted_savings_pct,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    backupRef: JSON.parse(row.backup_ref_json) as BackupRef,
    source: row.source as "built-in",
  };
}
