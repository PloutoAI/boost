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
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import { assertWithinAllowedRoots, claudeHome } from "../paths.ts";
import type { AppliedAction, StrategyAction } from "./client.ts";

/**
 * Validate that ``name`` is a single safe path segment.
 *
 * ``target`` arrives from the Plouto server, which the threat model
 * (C2) treats as untrusted input. A target like ``../../../tmp/x``
 * joined onto the skills dir escapes ~/.claude: ``removeSkill`` would
 * then ``rm -rf`` an arbitrary path and ``installSkill`` would write
 * outside the config tree — turning a compromised or malicious
 * workspace policy into arbitrary file delete/write on every
 * engineer's machine. A skill name (and every per-kind directory
 * target) is one path component by definition, so anything else is
 * refused. See threat-model.md C3.2 + the cloud-sync section.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

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

/**
 * Resolve ``~/.claude/skills/<target>`` after validating ``target`` is a
 * single segment, then re-check the resolved path is inside the config
 * root as defense-in-depth (catches a symlinked skills dir or any future
 * loosening of the segment check). Uses ``claudeHome()`` so it honors
 * ``CLAUDE_CONFIG_DIR`` the same way the rest of boost does.
 */
function skillDir(target: string): string {
  const safe = assertSafeSegment(target, "skill");
  const dir = join(claudeHome(), "skills", safe);
  return assertWithinAllowedRoots(dir, [claudeHome()]);
}

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
  const dir = skillDir(target);
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
  const dir = skillDir(target);
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

function recommendModel(target: string, cwd: string): void {
  // ``target`` (the model id) is written as a JSON *value*, so
  // JSON.stringify escapes it — not a path-injection vector. Still
  // reject control chars / absurd lengths so a bad policy can't write
  // garbage into the engineer's settings.
  if (typeof target !== "string" || target.length === 0 || target.length > 128 || hasControlChar(target)) {
    throw new Error(`unsafe model target: ${JSON.stringify(target)}`);
  }
  // ``cwd`` is the local hook payload (Claude Code's project dir), not
  // server input — but guard anyway: only write inside the user's home
  // tree, never to a project parked in a system location.
  const projectDir = resolve(cwd);
  const home = homedir();
  if (projectDir !== home && !projectDir.startsWith(home + sep)) {
    throw new Error(`refusing model recommendation outside home tree: ${projectDir}`);
  }
  // Write to <cwd>/.claude/settings.local.json — project-scoped so the
  // recommendation only applies inside the workspace this hook fired
  // for. Merge with existing JSON (don't stomp).
  const dir = join(projectDir, ".claude");
  mkdirSync(dir, { recursive: true });
  const path = assertWithinAllowedRoots(join(dir, "settings.local.json"), [projectDir]);
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
