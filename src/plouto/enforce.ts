/**
 * Apply one StrategyAction from Plouto to the engineer's local setup.
 *
 * All three enforced operations route through boost's reversible apply
 * substrate (`src/apply/`), so a bad policy push is undoable via
 * `boost revert` and inherits the same backup + path-safety + symlink
 * guarantees as a local fix:
 *
 *   kind=skill, op=install    → modify-file        (create-or-modify; revert deletes/restores)
 *   kind=skill, op=remove     → archive-directory  (reversible; replaced rm -rf)
 *   kind=model, op=recommend  → modify-settings-key (reversible)
 *
 * mcp / claude_md / prompt are not enforced yet (status="skipped").
 *
 * Failures are caught and converted into status="failed" receipts —
 * never re-thrown — so one bad action doesn't stop the sweep.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Database as BunDatabase } from "bun:sqlite";

import { applyFix } from "../apply/apply.ts";
import { archivedSkillsDir, claudeHome } from "../paths.ts";
import type { Fix, Operation } from "../types.ts";
import type { AppliedAction, StrategyAction } from "./client.ts";

/** Enforcement actions aren't versioned detectors — stamp a constant. */
const STRATEGY_VERSION = 1;

/** Marker that identifies a SKILL.md boost wrote (vs. a hand-edited one). */
const PLACEHOLDER_MARKER = "Plouto boost plugin's SessionStart hook";

const SKILL_PLACEHOLDER_NOTE = `\
<!--
This skill was installed by the Plouto boost plugin's SessionStart hook
on behalf of a workspace strategy. Phase 1 of the enforcement layer
writes only this placeholder so the directory exists and Claude Code
sees the SKILL.md — the full skill payload pull from the source repo
lands in Phase 2.
-->`;

export interface ApplyCtx {
  cwd: string;
  db: BunDatabase;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/**
 * Validate that ``name`` is a single safe path segment.
 *
 * ``target`` arrives from the Plouto server, which the threat model (C2)
 * treats as untrusted input. A target like ``../../../tmp/x`` joined onto
 * the skills dir escapes ~/.claude. The substrate's allowed-root check
 * catches escapes too, but this stops contained-but-wrong nesting
 * (``a/b``) and gives a clearer error at the boundary. See C3.2 / C7.1.
 */
function assertSafeSegment(name: string, kind: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) {
    throw new Error(`unsafe ${kind} target: empty or over 128 chars`);
  }
  if (
    name.includes("/") ||
    name.includes("\\") ||
    hasControlChar(name) ||
    name === "." ||
    name === ".." ||
    isAbsolute(name) ||
    basename(name) !== name
  ) {
    throw new Error(
      `unsafe ${kind} target: must be a single path segment, got ${JSON.stringify(name)}`,
    );
  }
  return name;
}

function strategyIdFor(action: StrategyAction): string {
  return action.strategy_id || `plouto:${action.kind}:${action.target}`;
}

export async function applyAction(
  action: StrategyAction,
  ctx: ApplyCtx,
): Promise<AppliedAction> {
  if (!action.in_cohort || action.op === "no-op") {
    return _receipt(action, "skipped", undefined);
  }

  try {
    if (action.kind === "skill" && action.op === "install") {
      const op = await installSkill(action.target, action.source, action.rationale, ctx.db, strategyIdFor(action));
      const r = _receipt(action, "applied");
      if (op) r.operation_id = op.operationId;
      return r;
    }
    if (action.kind === "skill" && action.op === "remove") {
      const op = await removeSkill(action.target, ctx.db, strategyIdFor(action));
      if (!op) return _receipt(action, "skipped", "skill not present");
      const r = _receipt(action, "applied");
      r.operation_id = op.operationId;
      return r;
    }
    if (action.kind === "model" && action.op === "recommend") {
      const op = await recommendModel(action.target, ctx.cwd, ctx.db, strategyIdFor(action));
      const r = _receipt(action, "applied");
      r.operation_id = op.operationId;
      return r;
    }
    // mcp / claude_md / prompt — not enforced in this plugin version.
    return _receipt(action, "skipped", "kind not enforced in this plugin version");
  } catch (err) {
    return _receipt(action, "failed", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Per-kind appliers
// ---------------------------------------------------------------------------

/**
 * Install a placeholder skill — reversibly, via the substrate's
 * create-or-modify `modify-file` primitive. Writes
 * ~/.claude/skills/<name>/SKILL.md; revert deletes it (if freshly created)
 * or restores the prior bytes (if it overwrote an earlier placeholder).
 *
 * Non-destructive guard: if a real, hand-edited SKILL.md already exists at
 * the target (one boost didn't write), leave it alone and return null —
 * the caller reports "applied" because the skill is effectively present.
 * Returns the Operation when a write happened.
 */
async function installSkill(
  target: string,
  source: string | null,
  rationale: string,
  db: BunDatabase,
  strategyId: string,
): Promise<Operation | null> {
  const name = assertSafeSegment(target, "skill");
  const skillMd = join(claudeHome(), "skills", name, "SKILL.md");
  if (existsSync(skillMd)) {
    const existing = readFileSync(skillMd, "utf8");
    if (!existing.includes(PLACEHOLDER_MARKER)) return null; // real skill — untouched
  }
  const body =
    `---\nname: ${name}\ndescription: Rolled out by Plouto. ${rationale || ""}\n---\n\n` +
    SKILL_PLACEHOLDER_NOTE +
    (source ? `\n\n<!-- source: ${source} -->\n` : "\n");
  const fix: Fix = { kind: "modify-file", payload: { filePath: skillMd, newContent: body } };
  return applyFix(fix, { db, strategyId, strategyVersion: STRATEGY_VERSION, predictedSavings: null });
}

/**
 * Remove a skill — reversibly. Archives ~/.claude/skills/<name>/ into
 * ~/.boost/archived-skills/ via the substrate (SHA-256 backup + operation
 * record), so `boost revert <op>` restores it. Replaces the old rm -rf.
 * Returns the Operation, or null if the skill isn't present (no-op).
 */
async function removeSkill(
  target: string,
  db: BunDatabase,
  strategyId: string,
): Promise<Operation | null> {
  const name = assertSafeSegment(target, "skill");
  const from = join(claudeHome(), "skills", name);
  if (!existsSync(from)) return null;
  // Archive destination must live under ~/.boost/ (the substrate enforces
  // this too). Timestamp-suffixed so repeated removes don't collide and so
  // revert's `<base>-*` archive sweep can find it.
  const to = join(archivedSkillsDir(), `${name}-${Date.now()}`);
  const fix: Fix = { kind: "archive-directory", payload: { fromPath: from, toPath: to } };
  return applyFix(fix, {
    db,
    strategyId,
    strategyVersion: STRATEGY_VERSION,
    predictedSavings: null,
  });
}

/**
 * Recommend a model — reversibly. Sets ``model`` in
 * <cwd>/.claude/settings.local.json via the substrate's settings-key
 * primitive (which records the prior value, so revert restores or removes
 * it). The model id is a JSON value (escaped on write), so it's not a
 * path-injection vector — but reject control chars / absurd lengths.
 */
async function recommendModel(
  target: string,
  cwd: string,
  db: BunDatabase,
  strategyId: string,
): Promise<Operation> {
  if (typeof target !== "string" || target.length === 0 || target.length > 128 || hasControlChar(target)) {
    throw new Error(`unsafe model target: ${JSON.stringify(target)}`);
  }
  // The substrate's settings-key primitive tolerates a missing file but not
  // a missing parent dir; a fresh project has no .claude/. cwd is the local
  // hook payload (not server input), so creating it here is safe. applyFix
  // still validates the settings path against the allowed write roots.
  const claudeDir = join(resolve(cwd), ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.local.json");
  const fix: Fix = {
    kind: "modify-settings-key",
    payload: { filePath: settingsPath, jsonPath: "model", newValue: target },
  };
  return applyFix(fix, {
    db,
    strategyId,
    strategyVersion: STRATEGY_VERSION,
    predictedSavings: null,
  });
}

// ---------------------------------------------------------------------------
// Receipt helpers
// ---------------------------------------------------------------------------

function _receipt(
  a: StrategyAction,
  status: AppliedAction["status"],
  error?: string,
): AppliedAction {
  return {
    strategy_id: a.strategy_id,
    kind: a.kind,
    target: a.target,
    op: a.op,
    status,
    error,
  };
}
