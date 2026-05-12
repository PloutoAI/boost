import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { loadOrCreateIdentity } from "../src/identity.ts";
import { identityPath } from "../src/paths.ts";
import { makeTempHome, type TempLoopHome } from "./helpers/temp-loop-home.ts";

let h: TempLoopHome;
beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => h.cleanup());

test("creates identity on first run", () => {
  const id1 = loadOrCreateIdentity();
  expect(id1.user_id).toMatch(/^boost_/);
  expect(id1.machine_id).toMatch(/^boostm_/);

  const id2 = loadOrCreateIdentity();
  expect(id2.user_id).toBe(id1.user_id);
});

test("file mode is 0600", () => {
  loadOrCreateIdentity();
  const st = fs.statSync(identityPath());
  expect(st.mode & 0o777).toBe(0o600);
});

test("corrupt file refuses to load", () => {
  fs.writeFileSync(identityPath(), "{not json");
  expect(() => loadOrCreateIdentity()).toThrow();
});
