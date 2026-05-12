/**
 * Generic apply executor. Backs up, race-checks (hash-based), applies,
 * persists an Operation row + JSON sidecar.
 *
 * Race detection: callers pass `observed` (sha256 hash at detection time).
 * If the file changed before apply, we abort cleanly. mtime/size aren't
 * sufficient under sub-millisecond writes that produce identical sizes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseJsonc } from "jsonc-parser";
import type { Database as BunDatabase } from "bun:sqlite";
import { assertNever, type Fix, type Operation } from "../types.ts";
import {
  atomicWriteFile,
  backupBeforeWrite,
  getJsonPath,
  hashDirectoryShallow,
  hashFile,
  setJsonPath,
} from "./backup.ts";
import {
  allowedWriteRoots,
  assertWithinAllowedRoots,
  boostHome,
  claudeHome,
  operationsDir,
} from "../paths.ts";

export type ObservedState = {
  /** sha256 hash of the file as observed at detection time. */
  hash: string;
};

export type ApplyContext = {
  db: BunDatabase;
  strategyId: string;
  strategyVersion: number;
  predictedSavings: number | null;
  /** State observed at detection time, when relevant. Undefined skips race check. */
  observed?: ObservedState;
};

/** Execute a Fix, with backup + race detection + persistent operation record. */
export async function applyFix(fix: Fix, ctx: ApplyContext): Promise<Operation> {
  switch (fix.kind) {
    case "modify-file":
      return applyModifyFile(fix.payload.filePath, fix.payload.newContent, ctx);
    case "modify-settings-key":
      return applyModifySettingsKey(
        fix.payload.filePath,
        fix.payload.jsonPath,
        fix.payload.newValue,
        ctx,
      );
    case "archive-directory":
      return applyArchiveDirectory(fix.payload.fromPath, fix.payload.toPath, ctx);
    default:
      return assertNever(fix);
  }
}

async function applyModifyFile(filePath: string, newContent: string, ctx: ApplyContext): Promise<Operation> {
  refuseSymlinkAtInput(filePath);
  const canon = assertWithinAllowedRoots(filePath, allowedWriteRoots());
  const safeRoot = pickSafeRoot(canon);
  const lst = fs.lstatSync(canon);
  if (lst.isSymbolicLink()) throw new Error(`refusing to modify symlink: ${canon}`);
  const beforeHash = hashFile(canon);
  raceCheck(beforeHash, ctx.observed);

  const backup = backupBeforeWrite({ kind: "file", filePath: canon });
  try {
    atomicWriteFile(canon, newContent, lst.mode & 0o777, safeRoot);
  } catch (err) {
    // Restore from backup on failure.
    try {
      atomicWriteFile(canon, fs.readFileSync(backup.ref.path), lst.mode & 0o777, safeRoot);
    } catch {
      throw new Error(
        `apply failed and restore failed: ${(err as Error).message}; backup at ${backup.ref.path}`,
      );
    }
    throw err;
  }
  const afterHash = hashFile(canon);

  return persistOperation(ctx, beforeHash, afterHash, backup.ref);
}

async function applyModifySettingsKey(
  filePath: string,
  jsonPath: string,
  newValue: unknown,
  ctx: ApplyContext,
): Promise<Operation> {
  refuseSymlinkAtInput(filePath);
  const canon = assertWithinAllowedRoots(filePath, allowedWriteRoots());
  const safeRoot = pickSafeRoot(canon);
  const exists = fs.existsSync(canon);
  if (exists) {
    const lst = fs.lstatSync(canon);
    if (lst.isSymbolicLink()) throw new Error(`refusing to modify symlink: ${canon}`);
  }
  const beforeHash = exists ? hashFile(canon) : EMPTY_HASH;
  if (exists) raceCheck(beforeHash, ctx.observed);

  let current: Record<string, unknown> = {};
  if (exists) {
    const txt = fs.readFileSync(canon, "utf8");
    const parsed = parseJsonc(txt);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  }
  const previousValue = getJsonPath(current, jsonPath);
  const backup = backupBeforeWrite({
    kind: "settings-key",
    filePath: canon,
    jsonPath,
    previousValue,
  });
  setJsonPath(current, jsonPath, newValue);
  const out = JSON.stringify(current, null, 2);
  atomicWriteFile(canon, out, 0o600, safeRoot);
  const afterHash = hashFile(canon);

  return persistOperation(ctx, beforeHash, afterHash, backup.ref);
}

async function applyArchiveDirectory(
  fromPath: string,
  toPath: string,
  ctx: ApplyContext,
): Promise<Operation> {
  refuseSymlinkAtInput(fromPath);
  const fromCanon = assertWithinAllowedRoots(fromPath, allowedWriteRoots());
  const lst = fs.lstatSync(fromCanon);
  if (lst.isSymbolicLink()) throw new Error(`refusing to archive symlink: ${fromCanon}`);

  // Directory race check: shallow hash compare. Cheap, catches structural drift.
  const beforeHash = hashDirectoryShallow(fromCanon);
  raceCheck(beforeHash, ctx.observed);

  // Backup tarball is the source of truth for revert. The "archived copy"
  // at toPath is a convenience artifact only; revert removes it.
  const backup = backupBeforeWrite({ kind: "directory", dirPath: fromCanon });

  // Move (rename) onto boost's archived-skills location. If rename fails across
  // devices, fall back to copy + remove.
  const toCanon = path.resolve(toPath);
  // toPath must live under boostHome — guard against accidental misuse.
  const bh = path.resolve(boostHome());
  if (toCanon !== bh && !toCanon.startsWith(bh + path.sep)) {
    throw new Error(`archive destination must live under ~/.boost/: ${toCanon}`);
  }
  fs.mkdirSync(path.dirname(toCanon), { recursive: true });
  try {
    fs.renameSync(fromCanon, toCanon);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      copyDirRecursive(fromCanon, toCanon);
      fs.rmSync(fromCanon, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
  const afterHash = hashDirectoryShallow(toCanon);
  return persistOperation(ctx, beforeHash, afterHash, backup.ref);
}

/** Pick the smallest allowed root that contains `canonTarget`. */
function pickSafeRoot(canonTarget: string): string {
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

/** Refuse if `inputPath` itself is a symlink (lstat the leaf only). */
function refuseSymlinkAtInput(inputPath: string): void {
  const abs = path.resolve(inputPath);
  try {
    const lst = fs.lstatSync(abs);
    if (lst.isSymbolicLink()) throw new Error(`refusing to operate on symlink: ${abs}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function raceCheck(currentHash: string, observed: ObservedState | undefined): void {
  if (!observed) return;
  if (currentHash !== observed.hash) {
    throw new Error(`target has changed since boost scanned it; please rerun boost and try again.`);
  }
}

function persistOperation(
  ctx: ApplyContext,
  beforeHash: string,
  afterHash: string,
  backupRef: Operation["backupRef"],
): Operation {
  const op: Operation = {
    operationId: randomUUID(),
    strategyId: ctx.strategyId,
    strategyVersion: ctx.strategyVersion,
    appliedAtIso: new Date().toISOString(),
    revertedAtIso: null,
    source: "built-in",
    beforeHash,
    afterHash,
    backupRef,
    predictedSavingsPercent: ctx.predictedSavings,
  };

  ctx.db
    .prepare(
      `INSERT INTO operations
         (operation_id, strategy_id, strategy_version, applied_at_iso, reverted_at_iso,
          predicted_savings_pct, before_hash, after_hash, backup_ref_json, source)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      op.operationId,
      op.strategyId,
      op.strategyVersion,
      op.appliedAtIso,
      op.predictedSavingsPercent,
      op.beforeHash,
      op.afterHash,
      JSON.stringify(op.backupRef),
      op.source,
    );

  const sidecar = path.join(operationsDir(), `${op.operationId}.json`);
  atomicWriteFile(sidecar, JSON.stringify(op, null, 2), 0o600);
  return op;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
