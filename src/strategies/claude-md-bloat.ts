/**
 * `claude-md-bloat` — flag oversized CLAUDE.md.
 *
 * v0.1 scope: only operates on the **global** CLAUDE.md (under
 * `${CLAUDE_CONFIG_DIR}/CLAUDE.md`). Project-level files often contain
 * shared team rules; nuking one to a stub on a shared repo deletes
 * teammates' guardrails. We deliberately leave project-level CLAUDE.md
 * alone in v0.1 and surface the count for awareness only.
 *
 * Reversible: the apply path takes a backup of the original CLAUDE.md
 * to `~/.boost/backups/` and records an Operation. `boost revert`
 * restores. Trust the reversibility primitives — every applied fix
 * in boost is safe in the sense that matters (recoverable).
 */
import type { Finding, Fix } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import { weeklySavingsPct } from "../summary.ts";
import { claudeHome } from "../paths.ts";
import { DAY_MS } from "../time.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const id = "claude-md-bloat";
const version = 1;

const THRESHOLD_WORDS = 1500;
const SEVERITY_HIGH = 4000;
const SEVERITY_MED_LOW = 2000;
const STUB = [
  "# CLAUDE.md (stub)",
  "",
  "The previous global CLAUDE.md was stashed by boost because it exceeded the",
  `recommended ${THRESHOLD_WORDS}-word baseline budget. The original is in`,
  "~/.boost/backups/. Copy back the rules you actually use and trim the rest.",
  "",
  "`boost revert` to undo this change.",
  "",
].join("\n");

const strategy: StrategyDefinition = {
  id,
  version,
  category: "clear-wins",
  defaultSeverity: "medium",

  title: (f) => {
    const total = (f.evidence.signals as { totalWords?: number }).totalWords ?? 0;
    return `Trim global CLAUDE.md (~${total.toLocaleString()} words)`;
  },

  detect: (ctx) => {
    const files = ctx.config.claudeMdFiles;
    if (files.length === 0) return null;

    // Identify the *global* file specifically. Project-level CLAUDE.md is
    // surfaced via affectedItems for awareness but not modified.
    let globalCanon: string;
    try {
      globalCanon = fs.realpathSync(path.join(claudeHome(), "CLAUDE.md"));
    } catch {
      // No global CLAUDE.md — nothing to do in v0.1.
      return null;
    }
    const globalFile = files.find((f) => f.path === globalCanon);
    if (!globalFile) return null;

    if (globalFile.wordCount <= THRESHOLD_WORDS) return null;

    // Don't flag if the user just edited it.
    try {
      const st = fs.statSync(globalFile.path);
      if (Date.now() - st.mtimeMs < 14 * DAY_MS) return null;
    } catch {
      // ignore
    }

    const overage = globalFile.wordCount - 800;
    const tokensPerRequest = Math.round(overage * 1.33);
    const weeklyPct =
      ctx.daysOfDataAvailable > 0 ? weeklySavingsPct(ctx.events.db, tokensPerRequest) : null;

    const severity: Finding["severity"] =
      globalFile.wordCount >= SEVERITY_HIGH
        ? "high"
        : globalFile.wordCount >= SEVERITY_MED_LOW
          ? "medium"
          : "low";

    // The fix carries the file path and a placeholder body, but is marked
    // requiresContent: true so the apply CLI refuses static application.
    // The trim-claude-md skill provides real LLM-synthesised content via
    // `--content-from-stdin`, which substitutes newContent at apply time.
    // Static stash-and-stub was theater; this enforces the real-trim path.
    const fix: Fix = {
      kind: "modify-file",
      payload: {
        filePath: globalFile.path,
        newContent: STUB,
        requiresContent: true,
      },
    };
    const fixes = [fix] as const;

    const projectFiles = files.filter((f) => f.path !== globalCanon);

    const finding: Finding = {
      strategyId: id,
      strategyVersion: version,
      category: "clear-wins",
      severity,
      title: "",
      affectedItems: [globalFile.path],
      estimatedTokensSavedPerRequest: tokensPerRequest,
      estimatedPercentOfWeeklyUsage: weeklyPct,
      evidence: {
        observedAtIso: ctx.now.toISOString(),
        windowDays: 0,
        signals: {
          totalWords: globalFile.wordCount,
          globalPath: globalFile.path,
          projectFiles: projectFiles.map((f) => ({ path: f.path, words: f.wordCount })),
        },
        humanReadable: `Global CLAUDE.md is ${globalFile.wordCount.toLocaleString()} words (target ≤ ${THRESHOLD_WORDS}).`,
      },
      fixes,
    };
    finding.title = strategy.title(finding);
    return finding;
  },

  explain: (f) => {
    const total = (f.evidence.signals as { totalWords?: number }).totalWords ?? 0;
    const tokens = f.estimatedTokensSavedPerRequest;
    return `Your global CLAUDE.md (~/.claude/CLAUDE.md) is ${total.toLocaleString()} words. Every word costs tokens on every turn — over ${THRESHOLD_WORDS} starts to dominate baseline usage.

boost will stash the global file to ~/.boost/backups/ and replace it with a small stub. You then copy back the rules that earn their keep. Project-level CLAUDE.md files are NOT touched — those often carry shared team rules.

Saves about ${tokens.toLocaleString()} tokens per request once trimmed.

Reversible: original is preserved in the backup, "boost revert" restores. Marked advisory — apply with confirmation, not bundled into tidy-ups.`;
  },
};

export default strategy;
