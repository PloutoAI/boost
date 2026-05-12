/**
 * `no-skills-advisory` — flag when a user is active on Claude Code but
 * has zero skills installed in `~/.claude/skills/`.
 *
 * Skills are reusable instructions/prompts Claude Code can load on
 * demand to stop rediscovering the same conventions, commands, and
 * entrypoints. An active user with zero skills is leaving real token
 * savings on the table — `boost reskill` reads their project activity
 * and proposes skill drafts.
 *
 * Advisory only. No automated fix — the "fix" is a nudge to run
 * `boost reskill`, which is itself a recommendation flow. Calling
 * `boost reskill` produces a separate report; this finding exists to
 * surface that boost has something to *say* about reskilling before
 * the user has to think to ask.
 *
 * Cold-start gate: ≥ 7 days of data. Also gates on ≥ 5 sessions in
 * the last 7 days — a fresh user with one experimental session
 * shouldn't get nagged.
 */
import type { Finding } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import { sessionsLastNDays } from "../summary.ts";

const id = "no-skills-advisory";
const version = 1;

const WINDOW_DAYS = 7;
const MIN_DAYS = 7;
const MIN_SESSIONS = 5;

const strategy: StrategyDefinition = {
  id,
  version,
  category: "trade-offs",
  defaultSeverity: "low",
  safeToApply: false,

  title: () => "No skills installed — run `boost reskill` for suggestions",

  detect: (ctx) => {
    if (ctx.daysOfDataAvailable < MIN_DAYS) return null;
    if (ctx.config.skills.length > 0) return null;

    const sessions = sessionsLastNDays(ctx.events.db, WINDOW_DAYS);
    if (sessions < MIN_SESSIONS) return null;

    const finding: Finding = {
      strategyId: id,
      strategyVersion: version,
      category: "trade-offs",
      severity: "low",
      safeToApply: false,
      title: "",
      affectedItems: [],
      estimatedTokensSavedPerRequest: 0,
      estimatedPercentOfWeeklyUsage: null,
      evidence: {
        observedAtIso: ctx.now.toISOString(),
        windowDays: WINDOW_DAYS,
        signals: {
          skillsInstalled: 0,
          sessionsLast7Days: sessions,
        },
        humanReadable: `0 skills installed in ~/.claude/skills/ across ${sessions} sessions (last ${WINDOW_DAYS} days).`,
      },
    };
    finding.title = strategy.title(finding);
    return finding;
  },

  explain: (f) => {
    const sig = f.evidence.signals as { sessionsLast7Days?: number };
    const lines: string[] = [];
    lines.push(
      `You've run ${sig.sessionsLast7Days ?? 0} Claude Code sessions in the last 7 days with zero skills installed.`,
    );
    lines.push("");
    lines.push("Skills are reusable instructions Claude Code can load on demand:");
    lines.push("  • Stop rediscovering the same project conventions every session.");
    lines.push("  • Encode commands, entrypoints, and repo idiosyncrasies once.");
    lines.push("  • Shave repeated context-gathering turns off your bill.");
    lines.push("");
    lines.push("Next step — boost will read your project activity and propose drafts:");
    lines.push("");
    lines.push("  boost reskill");
    lines.push("");
    lines.push("If a draft looks right:");
    lines.push("");
    lines.push("  boost reskill <name>     # writes ~/.boost/drafts/skills/<name>/SKILL.md");
    lines.push("");
    lines.push("Edit the draft and move it to ~/.claude/skills/ when ready.");
    lines.push("");
    lines.push("This finding is advisory — boost can't auto-create skills for you.");
    return lines.join("\n");
  },
};

export default strategy;
