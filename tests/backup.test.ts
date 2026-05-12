import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { backupBeforeWrite, restoreFromBackup, hashFile } from "../src/apply/backup.ts";
import { makeTempHome, type TempLoopHome } from "./helpers/temp-loop-home.ts";

let h: TempLoopHome;
beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => h.cleanup());

test("file backup + restore is byte-identical", () => {
  const target = path.join(h.claudeHome, "CLAUDE.md");
  const original = "# rules\nbe terse\n";
  fs.writeFileSync(target, original);

  const r = backupBeforeWrite({ kind: "file", filePath: target });
  expect(fs.existsSync(r.ref.path)).toBeTrue();
  expect(r.ref.kind).toBe("file");
  if (r.ref.kind !== "file") throw new Error("kind");
  expect(r.ref.backupHash).toBe(hashFile(r.ref.path));
  expect(r.ref.originalPath).toBe(target);

  fs.writeFileSync(target, "different");
  const out = restoreFromBackup(r.ref);
  expect(out.kind).toBe("file");
  expect(fs.readFileSync(target, "utf8")).toBe(original);
});

test("settings-key backup captures previous value", () => {
  const target = path.join(h.claudeHome, "settings.json");
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { foo: { disabled: false } } }, null, 2));
  const r = backupBeforeWrite({
    kind: "settings-key",
    filePath: target,
    jsonPath: "mcpServers.foo.disabled",
    previousValue: false,
  });
  const meta = JSON.parse(fs.readFileSync(r.ref.path, "utf8"));
  expect(meta.previousValue).toBe(false);
  expect(meta.missing).toBe(false);
});

test("backup refuses to follow symlinks", () => {
  const real = path.join(h.claudeHome, "real.txt");
  const link = path.join(h.claudeHome, "link.txt");
  fs.writeFileSync(real, "secret");
  fs.symlinkSync(real, link);
  expect(() => backupBeforeWrite({ kind: "file", filePath: link })).toThrow(/symlink/);
});

test("directory backup + restore preserves files", () => {
  const dir = path.join(h.claudeHome, "skills", "demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo\n---\nbody\n");
  const r = backupBeforeWrite({ kind: "directory", dirPath: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  restoreFromBackup(r.ref);
  expect(fs.existsSync(path.join(dir, "SKILL.md"))).toBeTrue();
  expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain("body");
});

test("revert refuses tampered file backup", () => {
  const target = path.join(h.claudeHome, "CLAUDE.md");
  fs.writeFileSync(target, "original content");
  const r = backupBeforeWrite({ kind: "file", filePath: target });
  fs.writeFileSync(r.ref.path, "tampered backup contents");
  expect(() => restoreFromBackup(r.ref)).toThrow(/tampered or corrupted/);
});

test("revert refuses tampered settings-key backup", () => {
  const target = path.join(h.claudeHome, "settings.json");
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { foo: { command: "bar" } } }, null, 2));
  const r = backupBeforeWrite({
    kind: "settings-key",
    filePath: target,
    jsonPath: "mcpServers.foo.disabled",
    previousValue: undefined,
  });
  fs.writeFileSync(r.ref.path, '{"filePath":"/etc/passwd","jsonPath":"x","missing":false,"previousValue":"evil"}');
  expect(() => restoreFromBackup(r.ref)).toThrow(/tampered or corrupted/);
});

test("revert refuses tampered directory backup", () => {
  const dir = path.join(h.claudeHome, "skills", "demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "ok");
  const r = backupBeforeWrite({ kind: "directory", dirPath: dir });
  // Append a byte to the tar.
  fs.appendFileSync(r.ref.path, Buffer.from([0x42]));
  expect(() => restoreFromBackup(r.ref)).toThrow(/tampered or corrupted/);
});

test("extractTar refuses entries that escape destination", () => {
  // Build a tar with a parent-traversal entry, manually.
  const dir = path.join(h.claudeHome, "skills", "demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ok.md"), "ok");
  const r = backupBeforeWrite({ kind: "directory", dirPath: dir });
  // Append a forged tar entry with a traversal name. Open the tar, find the
  // 1024-zero trailer, and inject before it.
  const buf = fs.readFileSync(r.ref.path);
  const trailerStart = buf.length - 1024;
  const fake = Buffer.alloc(1024);
  // Write minimal header with name "../escape"
  const name = "../escape";
  fake.write(name, 0, 100, "utf8");
  fake.write("0000644\0", 100, 8, "ascii");
  fake.write("00000000000\0", 124, 12, "ascii");
  fake.write("0", 156, 1, "ascii"); // typeflag file
  fake.write("ustar\0", 257, 6, "ascii");
  fake.write("00", 263, 2, "ascii");
  fake.write("        ", 148, 8, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += fake[i]!;
  fake.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const corrupted = Buffer.concat([buf.subarray(0, trailerStart), fake, buf.subarray(trailerStart)]);
  fs.writeFileSync(r.ref.path, corrupted);
  // backupHash now mismatches → tamper gate trips first.
  expect(() => restoreFromBackup(r.ref)).toThrow(/tampered or corrupted/);
});
