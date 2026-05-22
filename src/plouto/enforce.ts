/**
 * Apply one StrategyAction from Plouto to the engineer's local setup.
 *
 * Phase 1 dispatch matrix:
 *
 *   kind=skill,  op=install  → write ~/.claude/skills/<target>/SKILL.md placeholder
 *   kind=skill,  op=remove   → rm -rf ~/.claude/skills/<target>/
 *   kind=model,  op=recommend → write <cwd>/.claude/settings.local.json { "model": "<target>" }
 *   kind=mcp                 → not enforced yet (returns status="skipped" with note)
 *   kind=claude_md / prompt  → not enforced yet
 *   op=no-op                 → status="skipped"
 *
 * Every action returns an ``AppliedAction`` receipt the caller batches
 * up and POSTs to /api/plugin/strategies/applied.
 *
 * Failures are caught and converted into ``status="failed"`` receipts
 * with the error message — never re-thrown — so one bad action doesn't
 * stop subsequent actions in the same sweep from being tried.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AppliedAction, StrategyAction } from "./client.ts";

const SKILL_PLACEHOLDER_NOTE = `\
<!--
This skill was installed by the Plouto boost plugin's SessionStart hook
on behalf of a workspace strategy. Phase 1 of the enforcement layer
writes only this placeholder so the directory exists and Claude Code
sees the SKILL.md — the full skill payload pull from the source repo
lands in Phase 2.
-->`;

export function applyAction(
  action: StrategyAction,
  ctx: { cwd: string },
): AppliedAction {
  if (!action.in_cohort || action.op === "no-op") {
    return _receipt(action, "skipped", undefined);
  }

  try {
    if (action.kind === "skill" && action.op === "install") {
      installSkill(action.target, action.source, action.rationale);
      return _receipt(action, "applied");
    }
    if (action.kind === "skill" && action.op === "remove") {
      removeSkill(action.target);
      return _receipt(action, "applied");
    }
    if (action.kind === "model" && action.op === "recommend") {
      recommendModel(action.target, ctx.cwd);
      return _receipt(action, "applied");
    }
    // mcp / claude_md / prompt — not enforced in phase 1.
    return _receipt(action, "skipped", "kind not enforced in this plugin version");
  } catch (err) {
    return _receipt(action, "failed", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Per-kind appliers
// ---------------------------------------------------------------------------

function installSkill(target: string, source: string | null, rationale: string): void {
  const dir = join(homedir(), ".claude", "skills", target);
  mkdirSync(dir, { recursive: true });
  const skillMd = join(dir, "SKILL.md");
  // Don't stomp a real, hand-edited skill if the user already has one
  // at the same target name — write only if missing.
  if (existsSync(skillMd)) {
    const existing = readFileSync(skillMd, "utf8");
    if (!existing.includes("Plouto boost plugin's SessionStart hook")) {
      // Real skill exists — leave it alone. Caller sees this as
      // status="applied" but the file was untouched; that's correct
      // because the skill is effectively present on the engineer's
      // machine, just not via us.
      return;
    }
  }
  const body =
    `---\nname: ${target}\ndescription: Rolled out by Plouto. ${rationale || ""}\n---\n\n` +
    SKILL_PLACEHOLDER_NOTE +
    (source ? `\n\n<!-- source: ${source} -->\n` : "\n");
  writeFileSync(skillMd, body, "utf8");
}

function removeSkill(target: string): void {
  const dir = join(homedir(), ".claude", "skills", target);
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

function recommendModel(target: string, cwd: string): void {
  // Write to <cwd>/.claude/settings.local.json — project-scoped so the
  // recommendation only applies inside the workspace this hook fired
  // for. Merge with existing JSON (don't stomp).
  const dir = join(cwd, ".claude");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.local.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Malformed JSON — overwrite. Better than refusing to enforce.
      existing = {};
    }
  }
  existing.model = target;
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
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
