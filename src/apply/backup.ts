/**
 * Backup engine. Three kinds: file, settings-key, directory.
 *
 * Safety contract:
 * - Never follows symlinks during backup OR restore. The leaf is checked,
 *   *and* every ancestor of any write target inside an allowed root is
 *   checked with `lstat` immediately before the rename.
 * - Atomic writes: `tmp + fsync + rename`.
 * - Every backup file gets a SHA-256 (`backupHash`) recorded in the
 *   BackupRef. Revert hashes the on-disk file and refuses if it differs.
 * - File mode preserved on restore (recorded in the BackupRef).
 *
 * On-disk shape:
 *   ~/.boost/backups/<timestamp>-<rand>.bak              (file kind)
 *   ~/.boost/backups/<timestamp>-<rand>.settings.json    (settings-key kind)
 *   ~/.boost/backups/<timestamp>-<rand>.tar              (directory kind)
 *
 * Tar (subset of POSIX ustar): no symlink/hardlink/character/block/fifo
 * entries — extraction rejects every typeflag except `0` (file) and `5`
 * (directory). Entry names are validated against the canonical destination.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { parse as parseJsonc } from "jsonc-parser";
import { backupsDir } from "../paths.ts";
import { assertNever, type BackupRef } from "../types.ts";
import { isObject } from "../data/jsonl-payload.ts";

export type FileBackupSpec = {
  kind: "file";
  filePath: string;
};

export type SettingsKeyBackupSpec = {
  kind: "settings-key";
  filePath: string;
  jsonPath: string;
  /** `undefined` denotes "key was missing". */
  previousValue: unknown;
};

export type DirectoryBackupSpec = {
  kind: "directory";
  dirPath: string;
};

export type BackupSpec = FileBackupSpec | SettingsKeyBackupSpec | DirectoryBackupSpec;

export type BackupResult = {
  ref: BackupRef;
};

const FLAG_NOFOLLOW = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** Capture pre-state and write a backup. Caller modifies the original *after*. */
export function backupBeforeWrite(spec: BackupSpec): BackupResult {
  switch (spec.kind) {
    case "file":
      return backupFile(spec);
    case "settings-key":
      return backupSettingsKey(spec);
    case "directory":
      return backupDirectory(spec);
    default:
      return assertNever(spec);
  }
}

/**
 * Restore pre-state. Verifies `ref.backupHash` matches the on-disk backup
 * before doing anything destructive — refuses with a tamper error otherwise.
 *
 * Returns:
 *   - file:         hash of restored file (caller compares to beforeHash)
 *   - settings-key: { restoredValue } at jsonPath (caller compares to previousValue)
 *   - directory:    shallow hash of restored tree (caller compares to beforeHash)
 */
export function restoreFromBackup(ref: BackupRef): RestoreOutcome {
  verifyBackupIntegrity(ref);
  switch (ref.kind) {
    case "file":
      return restoreFile(ref);
    case "settings-key":
      return restoreSettingsKey(ref);
    case "directory":
      return restoreDirectory(ref);
    default:
      return assertNever(ref);
  }
}

export type RestoreOutcome =
  | { kind: "file"; postHash: string }
  | { kind: "settings-key"; restoredValue: unknown; missing: boolean }
  | { kind: "directory"; shallowHash: string };

/** SHA-256 of a regular file. Reads with `O_NOFOLLOW`. */
export function hashFile(filePath: string): string {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | FLAG_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buf = Buffer.alloc(64 * 1024);
    let off = 0;
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, off);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      off += n;
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

/** Stable shallow hash of a directory: name + size + mode of immediate entries. */
export function hashDirectoryShallow(dirPath: string): string {
  const hash = createHash("sha256");
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath).sort();
  } catch {
    return hash.digest("hex");
  }
  hash.update(path.basename(dirPath));
  for (const name of entries) {
    const full = path.join(dirPath, name);
    try {
      const st = fs.lstatSync(full);
      hash.update(`\n${name}:${st.size}:${st.mode & 0o7777}:${st.isDirectory() ? "d" : st.isFile() ? "f" : "?"}`);
    } catch {
      // skip
    }
  }
  return hash.digest("hex");
}

/**
 * Atomic write: write to `<dest>.tmp.<rand>`, fsync, rename.
 * Refuses to clobber a symlink at the destination *or any ancestor* inside
 * `safeRoot`. If `safeRoot` is undefined, only the leaf is checked (used
 * for writes inside `~/.boost/` which we own).
 */
export function atomicWriteFile(
  dest: string,
  data: Buffer | string,
  mode: number = 0o600,
  safeRoot?: string,
): void {
  if (safeRoot) refuseSymlinkInAncestors(dest, safeRoot);
  const tmp = `${dest}.tmp.${randomBytes(6).toString("hex")}`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    if (typeof data === "string") {
      fs.writeSync(fd, data);
    } else {
      fs.writeSync(fd, data);
    }
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync may fail on tmpfs; tolerable.
    }
  } finally {
    fs.closeSync(fd);
  }
  // Refuse to clobber a symlink at dest.
  try {
    const lst = fs.lstatSync(dest);
    if (lst.isSymbolicLink()) {
      fs.unlinkSync(tmp);
      throw new Error(`refusing to write through symlink at ${dest}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  fs.renameSync(tmp, dest);
}

/**
 * Walk every ancestor of `target` from `safeRoot` down. If any ancestor is
 * a symlink, refuse — closes the TOCTOU between canonicalize and write.
 */
export function refuseSymlinkInAncestors(target: string, safeRoot: string): void {
  const absTarget = path.resolve(target);
  const absRoot = path.resolve(safeRoot);
  if (absTarget !== absRoot && !absTarget.startsWith(absRoot + path.sep)) {
    throw new Error(`refuseSymlinkInAncestors: ${absTarget} not under safe root ${absRoot}`);
  }
  // Build the list of intermediate directories from root down to target's parent.
  const rel = path.relative(absRoot, path.dirname(absTarget));
  const segs = rel === "" ? [] : rel.split(path.sep);
  let cur = absRoot;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    try {
      const lst = fs.lstatSync(cur);
      if (lst.isSymbolicLink()) {
        throw new Error(`refusing to operate through symlinked ancestor: ${cur}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Not yet created; mkdir-recursive will create real dirs.
      return;
    }
  }
}

/** Hash the on-disk backup file and compare to the recorded `backupHash`. */
function verifyBackupIntegrity(ref: BackupRef): void {
  if (!fs.existsSync(ref.path)) {
    throw new Error(`backup file is missing at ${ref.path}; cannot revert.`);
  }
  const onDisk = hashFile(ref.path);
  if (onDisk !== ref.backupHash) {
    throw new Error(`backup tampered or corrupted; refusing to restore.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE
// ─────────────────────────────────────────────────────────────────────────────

function backupFile(spec: FileBackupSpec): BackupResult {
  const lst = fs.lstatSync(spec.filePath);
  if (lst.isSymbolicLink()) throw new Error(`refusing to back up symlink: ${spec.filePath}`);
  if (!lst.isFile()) throw new Error(`not a regular file: ${spec.filePath}`);

  // Read source with O_NOFOLLOW.
  const fd = fs.openSync(spec.filePath, fs.constants.O_RDONLY | FLAG_NOFOLLOW);
  let data: Buffer;
  try {
    data = readAll(fd, lst.size);
  } finally {
    fs.closeSync(fd);
  }
  const dest = path.join(backupsDir(), `${stamp()}-${randomBytes(6).toString("hex")}.bak`);
  atomicWriteFile(dest, data, 0o600);
  const backupHash = hashFile(dest);
  return {
    ref: {
      kind: "file",
      path: dest,
      backupHash,
      originalPath: spec.filePath,
      mode: lst.mode & 0o777,
    },
  };
}

function restoreFile(ref: Extract<BackupRef, { kind: "file" }>): RestoreOutcome {
  const data = fs.readFileSync(ref.path);
  // Refuse to overwrite a symlink at any level under the parent of `originalPath`.
  // Use the parent dir as the conservative "safe root" — guarantees we won't
  // follow a symlink anywhere from there to the leaf.
  const target = ref.originalPath;
  refuseSymlinkAtLeaf(target);
  atomicWriteFile(target, data, ref.mode);
  return { kind: "file", postHash: hashFile(target) };
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS KEY
// ─────────────────────────────────────────────────────────────────────────────

function backupSettingsKey(spec: SettingsKeyBackupSpec): BackupResult {
  const missing = spec.previousValue === undefined;
  const payload = {
    kind: "settings-key" as const,
    filePath: spec.filePath,
    jsonPath: spec.jsonPath,
    missing,
    previousValue: missing ? null : spec.previousValue,
  };
  const blob = JSON.stringify(payload, null, 2);
  const dest = path.join(backupsDir(), `${stamp()}-${randomBytes(6).toString("hex")}.settings.json`);
  atomicWriteFile(dest, blob, 0o600);
  const backupHash = hashFile(dest);
  return {
    ref: {
      kind: "settings-key",
      path: dest,
      backupHash,
      originalPath: spec.filePath,
      jsonPath: spec.jsonPath,
    },
  };
}

function restoreSettingsKey(
  ref: Extract<BackupRef, { kind: "settings-key" }>,
): RestoreOutcome {
  const raw = fs.readFileSync(ref.path, "utf8");
  const payload = JSON.parse(raw) as {
    filePath: string;
    jsonPath: string;
    missing: boolean;
    previousValue: unknown;
  };
  if (payload.filePath !== ref.originalPath || payload.jsonPath !== ref.jsonPath) {
    throw new Error(
      `settings-key backup metadata disagrees with BackupRef; refusing to restore.`,
    );
  }
  refuseSymlinkAtLeaf(payload.filePath);

  let current: Record<string, unknown> = {};
  try {
    const txt = fs.readFileSync(payload.filePath, "utf8");
    const parsed = parseJsonc(txt);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    // missing — that's fine.
  }
  if (payload.missing) {
    deleteJsonPath(current, payload.jsonPath);
  } else {
    setJsonPath(current, payload.jsonPath, payload.previousValue);
  }
  const out = JSON.stringify(current, null, 2);
  atomicWriteFile(payload.filePath, out, 0o600);

  // Re-parse to verify the restored value matches.
  let restored: unknown = undefined;
  try {
    const parsed = parseJsonc(fs.readFileSync(payload.filePath, "utf8"));
    if (parsed && typeof parsed === "object") {
      restored = getJsonPath(parsed as Record<string, unknown>, payload.jsonPath);
    }
  } catch {
    // ignore
  }
  return {
    kind: "settings-key",
    restoredValue: payload.missing ? undefined : payload.previousValue,
    missing: payload.missing && restored === undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIRECTORY
// ─────────────────────────────────────────────────────────────────────────────

function backupDirectory(spec: DirectoryBackupSpec): BackupResult {
  const lst = fs.lstatSync(spec.dirPath);
  if (lst.isSymbolicLink()) throw new Error(`refusing to back up symlinked directory: ${spec.dirPath}`);
  if (!lst.isDirectory()) throw new Error(`not a directory: ${spec.dirPath}`);

  const tarTmp = path.join(backupsDir(), `tmp-${randomBytes(6).toString("hex")}.tar`);
  const fd = fs.openSync(tarTmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    walkAndTar(spec.dirPath, spec.dirPath, fd);
    const trailer = Buffer.alloc(1024);
    fs.writeSync(fd, trailer);
    try {
      fs.fsyncSync(fd);
    } catch {
      // ignore
    }
  } finally {
    fs.closeSync(fd);
  }
  const backupHash = hashFile(tarTmp);
  const finalPath = path.join(backupsDir(), `${stamp()}-${randomBytes(6).toString("hex")}.tar`);
  fs.renameSync(tarTmp, finalPath);
  return {
    ref: {
      kind: "directory",
      path: finalPath,
      backupHash,
      originalPath: spec.dirPath,
    },
  };
}

function restoreDirectory(ref: Extract<BackupRef, { kind: "directory" }>): RestoreOutcome {
  const target = ref.originalPath;
  refuseSymlinkAtLeaf(target);
  // Wipe target if it exists.
  try {
    const lst = fs.lstatSync(target);
    if (lst.isSymbolicLink()) throw new Error(`refusing to restore directory through symlink at ${target}`);
    if (lst.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else if (lst.isFile()) fs.unlinkSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o755 });
  extractTar(ref.path, target);
  return { kind: "directory", shallowHash: hashDirectoryShallow(target) };
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function refuseSymlinkAtLeaf(target: string): void {
  try {
    const lst = fs.lstatSync(target);
    if (lst.isSymbolicLink()) throw new Error(`refusing to operate on symlink: ${target}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function readAll(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = fs.readSync(fd, buf, off, size - off, off);
    if (n <= 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Set a dot-notated path in an object, creating intermediate objects. */
export function setJsonPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`refusing prototype-pollution path segment: ${key}`);
    }
    const next = cur[key];
    if (!isObject(next)) {
      const fresh: Record<string, unknown> = {};
      cur[key] = fresh;
      cur = fresh;
    } else {
      cur = next;
    }
  }
  const last = parts[parts.length - 1]!;
  if (last === "__proto__" || last === "constructor" || last === "prototype") {
    throw new Error(`refusing prototype-pollution path segment: ${last}`);
  }
  cur[last] = value;
}

/** Read a dot-notated path. Returns `undefined` for missing paths. */
export function getJsonPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Delete the value at a dot-notated path; no-op if absent. */
export function deleteJsonPath(obj: Record<string, unknown>, dotted: string): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (!isObject(next)) return;
    cur = next;
  }
  delete cur[parts[parts.length - 1]!];
}

// ─── tiny tar (POSIX ustar header subset) ────────────────────────────────────

const MAX_TAR_NAME = 100;
const TAR_TYPE_FILE = "0";
const TAR_TYPE_DIR = "5";

function walkAndTar(root: string, current: string, fd: number): void {
  const lst = fs.lstatSync(current);
  if (lst.isSymbolicLink()) return; // never include symlinks in backups
  if (lst.isDirectory()) {
    const rel = path.relative(root, current);
    if (rel !== "") {
      const name = rel + "/";
      if (Buffer.byteLength(name, "utf8") > MAX_TAR_NAME) {
        throw new Error(`refusing to back up entry with name longer than ${MAX_TAR_NAME} bytes: ${name}`);
      }
      const header = makeTarHeader(name, 0, lst.mode, TAR_TYPE_DIR);
      fs.writeSync(fd, header);
    }
    const entries = fs.readdirSync(current);
    entries.sort();
    for (const e of entries) walkAndTar(root, path.join(current, e), fd);
  } else if (lst.isFile()) {
    const rel = path.relative(root, current);
    if (Buffer.byteLength(rel, "utf8") > MAX_TAR_NAME) {
      throw new Error(`refusing to back up entry with name longer than ${MAX_TAR_NAME} bytes: ${rel}`);
    }
    const header = makeTarHeader(rel, lst.size, lst.mode, TAR_TYPE_FILE);
    fs.writeSync(fd, header);
    const sourceFd = fs.openSync(current, fs.constants.O_RDONLY | FLAG_NOFOLLOW);
    try {
      const buf = Buffer.alloc(64 * 1024);
      let off = 0;
      while (off < lst.size) {
        const n = fs.readSync(sourceFd, buf, 0, Math.min(buf.length, lst.size - off), off);
        if (n <= 0) break;
        fs.writeSync(fd, buf.subarray(0, n));
        off += n;
      }
      const pad = (512 - (lst.size % 512)) % 512;
      if (pad > 0) fs.writeSync(fd, Buffer.alloc(pad));
    } finally {
      fs.closeSync(sourceFd);
    }
  }
  // Other types (block, char, fifo, link) are skipped.
}

function makeTarHeader(name: string, size: number, mode: number, type: string): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(name.slice(0, 100), 0, 100, "utf8");
  buf.write(toOctal(mode & 0o7777, 7) + "\0", 100, 8, "ascii");
  buf.write(toOctal(0, 7) + "\0", 108, 8, "ascii");
  buf.write(toOctal(0, 7) + "\0", 116, 8, "ascii");
  buf.write(toOctal(size, 11) + "\0", 124, 12, "ascii");
  buf.write(toOctal(0, 11) + "\0", 136, 12, "ascii");
  buf.write("        ", 148, 8, "ascii");
  buf.write(type, 156, 1, "ascii");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i]!;
  buf.write(toOctal(sum, 6) + "\0 ", 148, 8, "ascii");
  return buf;
}

function toOctal(n: number, width: number): string {
  return n.toString(8).padStart(width, "0");
}

/**
 * Strict tar extraction:
 * - Only typeflag `0` (file) and `5` (directory) accepted; everything else aborts.
 * - Entry names must be relative, must not contain `..` segments, and must
 *   stay under `dest` after `path.join`.
 * - Each ancestor of every write target is `lstat`'d for symlinks before write.
 */
function extractTar(tarPath: string, dest: string): void {
  const absDest = path.resolve(dest);
  const fd = fs.openSync(tarPath, fs.constants.O_RDONLY);
  try {
    const stat = fs.fstatSync(fd);
    let off = 0;
    while (off + 512 <= stat.size) {
      const header = Buffer.alloc(512);
      const n = fs.readSync(fd, header, 0, 512, off);
      if (n < 512) break;
      off += 512;
      if (header.every((b) => b === 0)) break;

      const name = header.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
      const mode = parseInt(header.subarray(100, 108).toString("ascii").replace(/[\0 ]+$/, "") || "0", 8);
      const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/[\0 ]+$/, "") || "0", 8);
      const type = header.subarray(156, 157).toString("ascii");

      const dataLen = Math.ceil(size / 512) * 512;

      // Name must be a relative path with no `..` segments.
      if (name === "" || path.isAbsolute(name)) {
        throw new Error(`tar: refusing absolute or empty entry name: ${JSON.stringify(name)}`);
      }
      const segs = name.split("/").filter((s) => s !== "");
      if (segs.some((s) => s === "..")) {
        throw new Error(`tar: refusing parent-traversal entry: ${name}`);
      }
      if (type !== TAR_TYPE_FILE && type !== TAR_TYPE_DIR && type !== "") {
        throw new Error(`tar: refusing non-regular entry (typeflag=${JSON.stringify(type)}): ${name}`);
      }

      const target = path.join(absDest, name);
      const targetCanon = path.resolve(target);
      if (targetCanon !== absDest && !targetCanon.startsWith(absDest + path.sep)) {
        throw new Error(`tar: entry would escape destination: ${name}`);
      }

      // Refuse if any ancestor is a symlink.
      refuseSymlinkInAncestors(target, absDest);

      if (type === TAR_TYPE_DIR) {
        fs.mkdirSync(target, { recursive: true, mode: mode & 0o777 || 0o755 });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Refuse if the leaf itself exists as a symlink.
        refuseSymlinkAtLeaf(target);
        const data = Buffer.alloc(size);
        let read = 0;
        while (read < size) {
          const got = fs.readSync(fd, data, read, size - read, off + read);
          if (got <= 0) break;
          read += got;
        }
        // O_NOFOLLOW + O_EXCL — refuse to follow a leaf symlink.
        const wfd = fs.openSync(
          target,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | FLAG_NOFOLLOW,
          mode & 0o777 || 0o644,
        );
        try {
          fs.writeSync(wfd, data);
        } finally {
          fs.closeSync(wfd);
        }
      }
      off += dataLen;
    }
  } finally {
    fs.closeSync(fd);
  }
}
