import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertWithinAllowedRoots } from "../../src/paths.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";

let h: TempLoopHome;
beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => h.cleanup());

test("rejects ../ traversal that escapes allowed roots", () => {
  const evil = path.join(h.loopHome, "..", "..", "tmp", "evil");
  expect(() => assertWithinAllowedRoots(evil, [h.loopHome])).toThrow();
});

test("rejects absolute paths outside roots", () => {
  expect(() => assertWithinAllowedRoots("/etc/passwd", [h.loopHome])).toThrow();
});

test("accepts canonical paths inside an allowed root", () => {
  const ok = path.join(h.loopHome, "subdir", "file");
  expect(() => assertWithinAllowedRoots(ok, [h.loopHome])).not.toThrow();
});

test("symlink pointing outside roots is rejected after canonicalization", () => {
  const dir = path.join(h.loopHome, "linked");
  fs.mkdirSync(dir);
  const link = path.join(h.loopHome, "out");
  fs.symlinkSync("/tmp", link);
  // link itself resolves to /tmp; assertion should refuse.
  expect(() => assertWithinAllowedRoots(link, [h.loopHome])).toThrow();
});
