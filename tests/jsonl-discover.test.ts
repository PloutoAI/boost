/**
 * Subagent JSONL discovery — Claude Code writes subagent sessions under
 * `~/.claude/projects/<project>/subagents/<id>.jsonl`. Our discoverJsonl
 * walks recursively, so subagents should be picked up automatically.
 * tokenuse special-cases the directory name; this test confirms our
 * recursive approach is a strict superset.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverJsonl } from "../src/data/jsonl-discover.ts";
import { makeTempHome, type TempLoopHome } from "./helpers/temp-loop-home.ts";

let h: TempLoopHome;
beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => h.cleanup());

const jsonlBytes = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    JSON.stringify({ uuid: `u${i}`, timestamp: "2026-01-01T00:00:00Z" }),
  ).join("\n") + "\n";

test("subagent JSONL files under projects/<p>/subagents/ are discovered", () => {
  const projectsDir = path.join(h.claudeHome, "projects", "myproject");
  fs.mkdirSync(projectsDir, { recursive: true });
  const top = path.join(projectsDir, "session-1.jsonl");
  const subagentDir = path.join(projectsDir, "subagents");
  fs.mkdirSync(subagentDir, { recursive: true });
  const sub = path.join(subagentDir, "agent-xyz.jsonl");
  fs.writeFileSync(top, jsonlBytes(5));
  fs.writeFileSync(sub, jsonlBytes(5));

  const files = discoverJsonl();
  const names = files.map((f) => path.basename(f.path)).sort();
  expect(names).toContain("session-1.jsonl");
  expect(names).toContain("agent-xyz.jsonl");
});

test("symlinks inside projects/ are skipped, not followed", () => {
  const projectsDir = path.join(h.claudeHome, "projects", "myproject");
  fs.mkdirSync(projectsDir, { recursive: true });
  const real = path.join(projectsDir, "real.jsonl");
  fs.writeFileSync(real, jsonlBytes(5));
  // Create a symlink alongside.
  const link = path.join(projectsDir, "linked.jsonl");
  fs.symlinkSync(real, link);

  const files = discoverJsonl();
  const names = files.map((f) => path.basename(f.path));
  expect(names).toContain("real.jsonl");
  // The symlink is rejected by the Dirent.isFile() check before lstat fires —
  // we never even attempt to read through it. That's the property that matters.
  expect(names).not.toContain("linked.jsonl");
});

test("returns empty array if projects directory doesn't exist", () => {
  expect(discoverJsonl()).toEqual([]);
});

test("files under MIN_BYTES are skipped", () => {
  const projectsDir = path.join(h.claudeHome, "projects", "myproject");
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, "tiny.jsonl"), "x");
  fs.writeFileSync(path.join(projectsDir, "big.jsonl"), jsonlBytes(20));
  const files = discoverJsonl();
  const names = files.map((f) => path.basename(f.path));
  expect(names).toContain("big.jsonl");
  expect(names).not.toContain("tiny.jsonl");
});
