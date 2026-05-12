/**
 * `unused-skill-archive` — flag skills installed in `~/.claude/skills/` that
 * have not been activated in N days (default 60). Cold-start gate: ≥ 14 days.
 *
 * Note: v0.1 of the JSONL normalizer doesn't yet produce `skill_activated`
 * events (signal needs OTel; see B14). Until then, this detector flags
 * skills that have been installed for ≥ 14 days *and* have no events at all
 * — best-effort approximation. Will tighten in v0.2 once OTel ingest lands.
 */
import type { Finding, Fix } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import * as path from "node:path";
import { archivedSkillsDir } from "../paths.ts";
import { weeklySavingsPct } from "../summary.ts";
import { DAY_MS } from "../time.ts";

const id = "unused-skill-archive";
const version = 2;
const WINDOW_DAYS = 60;
const MIN_DAYS = 14;

const strategy: StrategyDefinition = {
  id,
  version,
  category: "clear-wins",
  defaultSeverity: "low",
  safeToApply: true,

  title: (f) => `Archive ${f.affectedItems.length} unused skill${f.affectedItems.length === 1 ? "" : "s"}`,

  detect: (ctx) => {
    if (ctx.daysOfDataAvailable < MIN_DAYS) return null;
    const skills = ctx.config.skills;
    if (skills.length === 0) return null;

    const sinceMs = ctx.now.getTime() - WINDOW_DAYS * DAY_MS;
    const sinceIso = new Date(sinceMs).toISOString();

    // Look for any `skill_activated` events in the window. If the table is
    // empty (v0.1 normalizer doesn't emit them), we conservatively use
    // "skill installed ≥ 14 days, never invoked" as a proxy.
    const skillEventCount = ctx.events.db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM events WHERE event_type = 'skill_activated' AND timestamp_iso >= ?`,
      )
      .get(sinceIso);
    const haveSkillSignal = (skillEventCount?.c ?? 0) > 0;

    // v0.1 normalizer doesn't emit `skill_activated`. Without that signal we
    // have no honest basis for flagging skills as "unused" — installed-but-
    // never-invoked is indistinguishable from "rarely needed but useful".
    // The detector stays disabled until the OTel pipeline lands in v0.2+.
    if (!haveSkillSignal) return null;

    const candidates: typeof skills = [];
    for (const skill of skills) {
      // Grace period: skip if installed < 14 days ago.
      if (Date.now() - skill.mtimeMs < 14 * DAY_MS) continue;
      const fired = ctx.events.db
        .query<
          { c: number },
          [string, string]
        >(
          `SELECT COUNT(*) AS c FROM events
           WHERE event_type = 'skill_activated'
             AND timestamp_iso >= ?
             AND json_extract(payload_json, '$.skill_name') = ?`,
        )
        .get(sinceIso, skill.name);
      if ((fired?.c ?? 0) === 0) candidates.push(skill);
    }

    if (candidates.length === 0) return null;

    // Use the *actual* per-skill frontmatter token counts (measured by
    // the enumerator) rather than a flat estimate. Frontmatter is the
    // ambient cost — it loads in every session for trigger matching.
    // Body tokens only load on activation, which by definition isn't
    // happening here, so they don't count toward "savings on archive".
    const tokensPerRequest = candidates.reduce((n, s) => n + s.frontmatterTokens, 0);
    const weeklyPct = weeklySavingsPct(ctx.events.db, tokensPerRequest);

    const fixes: Fix[] = candidates.map((skill) => ({
      kind: "archive-directory",
      payload: {
        fromPath: skill.path,
        toPath: path.join(archivedSkillsDir(), `${skill.name}-${stamp()}`),
      },
    }));

    const flaggedDetail = candidates.map((s) => ({
      name: s.name,
      frontmatterTokens: s.frontmatterTokens,
      bodyTokens: s.bodyTokens,
    }));

    const finding: Finding = {
      strategyId: id,
      strategyVersion: version,
      category: "clear-wins",
      severity: candidates.length >= 5 ? "medium" : "low",
      safeToApply: true,
      title: "",
      affectedItems: candidates.map((s) => s.name),
      estimatedTokensSavedPerRequest: tokensPerRequest,
      estimatedPercentOfWeeklyUsage: weeklyPct,
      evidence: {
        observedAtIso: ctx.now.toISOString(),
        windowDays: WINDOW_DAYS,
        signals: {
          installedSkills: skills.map((s) => s.name),
          flagged: flaggedDetail,
          totalFrontmatterTokensFlagged: tokensPerRequest,
        },
        humanReadable: `${candidates.length} skill(s) installed but no activation in last ${WINDOW_DAYS} days — ${tokensPerRequest} frontmatter tokens load every session.`,
      },
      fixes: fixes as unknown as readonly [Fix, ...Fix[]],
    };
    finding.title = strategy.title(finding);
    return finding;
  },

  explain: (f) => {
    const flagged = (f.evidence.signals.flagged ?? []) as Array<{
      name: string;
      frontmatterTokens: number;
      bodyTokens: number;
    }>;
    const total = (f.evidence.signals.totalFrontmatterTokensFlagged ?? 0) as number;
    const items = flagged
      .sort((a, b) => b.frontmatterTokens - a.frontmatterTokens)
      .map(
        (s) =>
          `  • ${s.name.padEnd(32)} ${String(s.frontmatterTokens).padStart(4)} frontmatter · ${String(s.bodyTokens).padStart(5)} body`,
      )
      .join("\n");
    return `These skills are installed under ~/.claude/skills/ but haven't been used recently. Frontmatter loads into every session for trigger matching; body tokens only load on activation. Archiving stops the frontmatter cost.

${items}

Total frontmatter savings: ${total} tokens per session.

boost will move each unused skill to ~/.boost/archived-skills/<name>-<timestamp>/, outside ~/.claude/, so Claude Code stops loading them.

Reversible: backed-up tarball stored, "boost revert" restores.`;
  },
};

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export default strategy;
