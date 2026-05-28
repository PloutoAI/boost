/**
 * Enforcement-path guards + reversibility.
 *
 * ``StrategyAction.target`` comes from the Plouto server, which the threat
 * model treats as untrusted. These tests pin two things:
 *   1. A crafted target can't escape ~/.claude/skills/ (traversal guard).
 *   2. remove + model-recommend route through the reversible apply
 *      substrate — they record an operation and `boost revert` undoes them.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { applyAction } from "../../src/plouto/enforce.ts";
import type { StrategyAction } from "../../src/plouto/client.ts";
import { LoopDatabase } from "../../src/db.ts";
import { revertOperation } from "../../src/apply/revert.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";

let h: TempLoopHome;
let loop: LoopDatabase;
beforeEach(() => {
  h = makeTempHome();
  loop = LoopDatabase.open();
});
afterEach(() => {
  loop.close();
  h.cleanup();
});

function action(over: Partial<StrategyAction>): StrategyAction {
  return {
    strategy_id: "s1",
    kind: "skill",
    target: "x",
    mode: "hard",
    op: "install",
    source: null,
    rollout_pct: 100,
    in_cohort: true,
    rationale: "test",
    ...over,
  };
}

function ctx(over: Partial<{ cwd: string }> = {}) {
  return { cwd: h.claudeHome, db: loop.db, ...over };
}

// ── traversal guards ────────────────────────────────────────────────────────

test("install rejects ../ traversal and writes nothing outside the skills dir", async () => {
  const escaped = path.join(h.claudeHome, "..", "escaped");
  const r = await applyAction(action({ op: "install", target: "../../escaped/evil" }), ctx());
  expect(r.status).toBe("failed");
  expect(r.error).toContain("single path segment");
  expect(fs.existsSync(escaped)).toBe(false);
});

test("remove refuses a traversal target — victim dir survives", async () => {
  const victim = path.join(h.claudeHome, "..", "victim");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "keep.txt"), "important", "utf8");

  const r = await applyAction(action({ op: "remove", target: "../../victim" }), ctx());
  expect(r.status).toBe("failed");
  expect(fs.existsSync(path.join(victim, "keep.txt"))).toBe(true);
});

test("rejects absolute / dot / separator / control-char targets", async () => {
  const NUL = String.fromCharCode(0), TAB = String.fromCharCode(9);
  for (const bad of ["/tmp/abs", ".", "..", "a/b", "a\\b", `w${NUL}n`, `t${TAB}n`]) {
    const r = await applyAction(action({ op: "install", target: bad }), ctx());
    expect(r.status).toBe("failed");
  }
});

// ── install happy path + preservation ────────────────────────────────────────

test("install writes a placeholder SKILL.md inside the skills dir", async () => {
  const r = await applyAction(action({ op: "install", target: "mcp-builder" }), ctx());
  expect(r.status).toBe("applied");
  expect(r.operation_id).toBeTruthy(); // now reversible — went through the substrate
  const md = path.join(h.claudeHome, "skills", "mcp-builder", "SKILL.md");
  expect(fs.existsSync(md)).toBe(true);
  expect(fs.readFileSync(md, "utf8")).toContain("SessionStart hook");
});

test("install creates reversibly; revert deletes the created SKILL.md", async () => {
  const md = path.join(h.claudeHome, "skills", "fresh", "SKILL.md");
  const r = await applyAction(action({ op: "install", target: "fresh" }), ctx());
  expect(r.status).toBe("applied");
  expect(fs.existsSync(md)).toBe(true);

  await revertOperation(loop.db, r.operation_id!);
  expect(fs.existsSync(md)).toBe(false); // the create was undone
});

test("install over a stale placeholder; revert restores the prior placeholder", async () => {
  // First install writes placeholder v1.
  const first = await applyAction(action({ op: "install", target: "evolving", rationale: "v1" }), ctx());
  const md = path.join(h.claudeHome, "skills", "evolving", "SKILL.md");
  const v1 = fs.readFileSync(md, "utf8");
  expect(v1).toContain("v1");

  // Second install overwrites with v2 (still a boost placeholder, so allowed).
  const second = await applyAction(action({ op: "install", target: "evolving", rationale: "v2" }), ctx());
  expect(second.operation_id).toBeTruthy();
  expect(fs.readFileSync(md, "utf8")).toContain("v2");

  // Reverting the second op restores v1.
  await revertOperation(loop.db, second.operation_id!);
  expect(fs.readFileSync(md, "utf8")).toBe(v1);
  void first;
});

test("revert refuses to delete a created file the user edited since", async () => {
  const md = path.join(h.claudeHome, "skills", "touched", "SKILL.md");
  const r = await applyAction(action({ op: "install", target: "touched" }), ctx());
  // User turns the placeholder into a real, hand-edited skill.
  fs.writeFileSync(md, "---\nname: touched\n---\nI made this real", "utf8");

  await expect(revertOperation(loop.db, r.operation_id!)).rejects.toThrow(/changed since boost created it/);
  expect(fs.existsSync(md)).toBe(true); // user's work preserved
});

test("install leaves a hand-edited real skill untouched", async () => {
  const dir = path.join(h.claudeHome, "skills", "mine");
  fs.mkdirSync(dir, { recursive: true });
  const md = path.join(dir, "SKILL.md");
  fs.writeFileSync(md, "---\nname: mine\n---\nhand written", "utf8");

  const r = await applyAction(action({ op: "install", target: "mine" }), ctx());
  expect(r.status).toBe("applied");
  expect(fs.readFileSync(md, "utf8")).toBe("---\nname: mine\n---\nhand written");
});

// ── reversibility: remove → archive-directory → revert restores ──────────────

test("remove archives reversibly; revert restores the skill", async () => {
  // Plant a real skill.
  const dir = path.join(h.claudeHome, "skills", "doomed");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: doomed\n---\nbody", "utf8");

  const r = await applyAction(action({ op: "remove", target: "doomed" }), ctx());
  expect(r.status).toBe("applied");
  expect(r.operation_id).toBeTruthy();
  expect(fs.existsSync(dir)).toBe(false); // gone from skills/

  // Revert via the recorded operation → skill comes back.
  await revertOperation(loop.db, r.operation_id!);
  expect(fs.existsSync(path.join(dir, "SKILL.md"))).toBe(true);
  expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain("body");
});

test("remove of a non-present skill is a no-op skip", async () => {
  const r = await applyAction(action({ op: "remove", target: "never-existed" }), ctx());
  expect(r.status).toBe("skipped");
  expect(r.operation_id).toBeUndefined();
});

// ── reversibility: model recommend → settings-key → revert removes key ───────

test("model recommend writes settings.local.json reversibly", async () => {
  // cwd under claudeHome so it's inside an allowed write root in the harness.
  const proj = path.join(h.claudeHome, "proj");
  fs.mkdirSync(proj, { recursive: true });

  const r = await applyAction(
    action({ kind: "model", op: "recommend", target: "claude-haiku-4-5" }),
    ctx({ cwd: proj }),
  );
  expect(r.status).toBe("applied");
  expect(r.operation_id).toBeTruthy();

  const settings = path.join(proj, ".claude", "settings.local.json");
  expect(JSON.parse(fs.readFileSync(settings, "utf8")).model).toBe("claude-haiku-4-5");

  // Revert → the key we added is removed again.
  await revertOperation(loop.db, r.operation_id!);
  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  expect(after.model).toBeUndefined();
});

test("model recommend rejects a control-char model id", async () => {
  const r = await applyAction(
    action({ kind: "model", op: "recommend", target: "claude\nopus" }),
    ctx(),
  );
  expect(r.status).toBe("failed");
});

// ── cohort gating ────────────────────────────────────────────────────────────

test("out-of-cohort and no-op actions are skipped without writing", async () => {
  const outCohort = await applyAction(action({ op: "install", target: "x", in_cohort: false }), ctx());
  expect(outCohort.status).toBe("skipped");
  const noop = await applyAction(action({ op: "no-op", target: "x" }), ctx());
  expect(noop.status).toBe("skipped");
});
