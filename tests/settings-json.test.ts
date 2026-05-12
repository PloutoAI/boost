import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readSettings } from "../src/data/settings-json.ts";
import { makeTempHome, type TempLoopHome } from "./helpers/temp-loop-home.ts";

let h: TempLoopHome;
beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => h.cleanup());

test("returns null with warning when missing", () => {
  const r = readSettings();
  expect(r.settings).toBeNull();
  expect(r.warning).toBeDefined();
});

test("parses JSON-with-comments", () => {
  fs.writeFileSync(
    path.join(h.claudeHome, "settings.json"),
    `// top-level comment\n{\n  "mcpServers": { "foo": { "command": "bar" } }\n}\n`,
  );
  const r = readSettings();
  expect(r.settings).not.toBeNull();
  expect(r.settings?.mcpServers.length).toBe(1);
});

test("strips top-level prototype-pollution keys", () => {
  fs.writeFileSync(
    path.join(h.claudeHome, "settings.json"),
    JSON.stringify({ __proto__: { polluted: true }, mcpServers: {} }),
  );
  const r = readSettings();
  expect(r.settings).not.toBeNull();
  expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
});

test("strips nested prototype-pollution keys (deep sanitize)", () => {
  fs.writeFileSync(
    path.join(h.claudeHome, "settings.json"),
    JSON.stringify({
      mcpServers: {
        foo: {
          command: "bar",
          __proto__: { hijacked: true },
          env: { __proto__: { also: 1 } },
        },
      },
    }),
  );
  const r = readSettings();
  expect(r.settings).not.toBeNull();
  // No proto keys survive at any depth.
  const raw = r.settings!.raw as Record<string, unknown>;
  const foo = (raw.mcpServers as Record<string, unknown>).foo as Record<string, unknown>;
  expect(Object.keys(foo)).not.toContain("__proto__");
  expect(Object.keys(foo.env as Record<string, unknown>)).not.toContain("__proto__");
  expect((Object.prototype as Record<string, unknown>).hijacked).toBeUndefined();
  expect((Object.prototype as Record<string, unknown>).also).toBeUndefined();
});

test("invalid JSON returns null with warning", () => {
  fs.writeFileSync(path.join(h.claudeHome, "settings.json"), "{not valid");
  const r = readSettings();
  expect(r.settings).toBeNull();
  expect(r.warning).toContain("invalid JSON");
});
