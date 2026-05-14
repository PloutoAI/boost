import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LoopDatabase } from "../src/db.ts";
import { applyFix } from "../src/apply/apply.ts";
import { revertOperation } from "../src/apply/revert.ts";
import { makeTempHome, type TempLoopHome } from "./helpers/temp-loop-home.ts";

let h: TempLoopHome;
beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => h.cleanup());

test("modify-file: apply then revert restores byte-for-byte", async () => {
  const handle = LoopDatabase.open();
  const target = path.join(h.claudeHome, "CLAUDE.md");
  const original = "# rules\nbe terse\n# end\n";
  fs.writeFileSync(target, original, { mode: 0o644 });

  const op = await applyFix(
    { kind: "modify-file", payload: { filePath: target, newContent: "# stub\n" } },
    { db: handle.db, strategyId: "claude-md-bloat", strategyVersion: 1, predictedSavings: 5 },
  );
  expect(fs.readFileSync(target, "utf8")).toBe("# stub\n");

  await revertOperation(handle.db, op.operationId);
  expect(fs.readFileSync(target, "utf8")).toBe(original);
  handle.close();
});

test("modify-settings-key: apply sets disabled, revert removes it", async () => {
  const handle = LoopDatabase.open();
  const target = path.join(h.claudeHome, "settings.json");
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { foo: { command: "bar" } } }, null, 2));

  const op = await applyFix(
    {
      kind: "modify-settings-key",
      payload: { filePath: target, jsonPath: "mcpServers.foo.disabled", newValue: true },
    },
    { db: handle.db, strategyId: "unused-mcp-disable", strategyVersion: 1, predictedSavings: 8 },
  );
  let parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  expect(parsed.mcpServers.foo.disabled).toBe(true);

  await revertOperation(handle.db, op.operationId);
  parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  expect(parsed.mcpServers.foo.disabled).toBeUndefined();
  handle.close();
});

test("modify-file rejects symlinks", async () => {
  const handle = LoopDatabase.open();
  const real = path.join(h.claudeHome, "real.md");
  fs.writeFileSync(real, "real");
  const link = path.join(h.claudeHome, "linked.md");
  fs.symlinkSync(real, link);
  await expect(
    applyFix(
      { kind: "modify-file", payload: { filePath: link, newContent: "x" } },
      { db: handle.db, strategyId: "x", strategyVersion: 1, predictedSavings: null },
    ),
  ).rejects.toThrow(/symlink/);
  handle.close();
});

test("archive-directory: apply then revert restores files and removes archive", async () => {
  const handle = LoopDatabase.open();
  const skillsDir = path.join(h.claudeHome, "skills", "demo");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "---\nname: demo\n---\nbody\n");

  const archivedDest = path.join(h.loopHome, "archived-skills", "demo-stamp");
  const op = await applyFix(
    { kind: "archive-directory", payload: { fromPath: skillsDir, toPath: archivedDest } },
    { db: handle.db, strategyId: "unused-skill-archive", strategyVersion: 1, predictedSavings: 1 },
  );
  expect(fs.existsSync(skillsDir)).toBeFalse();
  expect(fs.existsSync(archivedDest)).toBeTrue();

  await revertOperation(handle.db, op.operationId);
  // Original is restored.
  expect(fs.existsSync(path.join(skillsDir, "SKILL.md"))).toBeTrue();
  expect(fs.readFileSync(path.join(skillsDir, "SKILL.md"), "utf8")).toContain("body");
  // Archive copy is gone.
  expect(fs.existsSync(archivedDest)).toBeFalse();
  handle.close();
});

test("revert refuses when an ancestor directory has been swapped for a symlink", async () => {
  const handle = LoopDatabase.open();
  // Put the target inside a subdir so there's a real ancestor to swap.
  const sub = path.join(h.claudeHome, "rules");
  fs.mkdirSync(sub);
  const target = path.join(sub, "CLAUDE.md");
  const original = "# rules\nbe terse\n";
  fs.writeFileSync(target, original, { mode: 0o644 });

  const op = await applyFix(
    { kind: "modify-file", payload: { filePath: target, newContent: "# stub\n" } },
    { db: handle.db, strategyId: "claude-md-bloat", strategyVersion: 1, predictedSavings: null },
  );

  // Attacker move: swap the ancestor for a symlink pointing elsewhere.
  // Revert should refuse instead of writing through the link.
  const decoy = path.join(h.loopHome, "decoy");
  fs.mkdirSync(decoy);
  fs.writeFileSync(path.join(decoy, "CLAUDE.md"), "decoy\n");
  fs.rmSync(sub, { recursive: true });
  fs.symlinkSync(decoy, sub);

  await expect(revertOperation(handle.db, op.operationId)).rejects.toThrow(/symlink/);
  // The decoy must not have been overwritten with the backup contents.
  expect(fs.readFileSync(path.join(decoy, "CLAUDE.md"), "utf8")).toBe("decoy\n");
  handle.close();
});

test("hash-based race-check aborts when target changed since detection", async () => {
  const handle = LoopDatabase.open();
  const { hashFile } = await import("../src/apply/backup.ts");
  const target = path.join(h.claudeHome, "CLAUDE.md");
  fs.writeFileSync(target, "original\n");
  const observed = { hash: hashFile(target) };
  // Mutate after detection-time observation.
  fs.writeFileSync(target, "concurrent change\n");
  await expect(
    applyFix(
      { kind: "modify-file", payload: { filePath: target, newContent: "new\n" } },
      { db: handle.db, strategyId: "x", strategyVersion: 1, predictedSavings: null, observed },
    ),
  ).rejects.toThrow(/changed since boost scanned/);
  handle.close();
});
