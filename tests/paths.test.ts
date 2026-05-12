import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { makeTempHome, type TempLoopHome } from "./helpers/temp-loop-home.ts";
import { dbPath, backupsDir, identityPath, boostHome, assertWithinAllowedRoots } from "../src/paths.ts";

let h: TempLoopHome;

beforeEach(() => {
  h = makeTempHome();
});

afterEach(() => {
  h.cleanup();
});

test("BOOST_HOME override is honored", () => {
  expect(boostHome()).toBe(h.loopHome);
});

test("dbPath() and friends auto-create parent dirs", () => {
  const db = dbPath();
  expect(db.startsWith(h.loopHome)).toBeTrue();
  expect(fs.existsSync(h.loopHome)).toBeTrue();

  const backups = backupsDir();
  expect(fs.existsSync(backups)).toBeTrue();
  const id = identityPath();
  expect(id.endsWith("identity.json")).toBeTrue();
});

test("assertWithinAllowedRoots refuses paths outside roots", () => {
  expect(() => assertWithinAllowedRoots("/etc/passwd", [h.loopHome])).toThrow();
  expect(() => assertWithinAllowedRoots(`${h.loopHome}/foo.txt`, [h.loopHome])).not.toThrow();
});
