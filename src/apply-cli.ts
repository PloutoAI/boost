/**
 * `boost apply` — non-interactive CLI for the apply primitive.
 *
 * Two shapes:
 *   - boost apply <strategy-id>   apply every fix on that finding
 *   - boost apply --all           apply every clear-win finding that has a fix
 *
 * Every applied fix is reversible (operation + backup recorded; `boost
 * revert` restores). There is no "destructive but reversible" middle
 * tier — the apply/revert primitives provide safety; trust them.
 *
 * The race-check field (`observed`) is omitted because the CLI flow is
 * see-findings → run-apply, not interactive. Users wanting full race
 * protection should re-run boost between findings.
 */
import { bootstrap } from "./orchestrate.ts";
import { applyFix } from "./apply/apply.ts";
import type { Finding } from "./types.ts";

export type ApplyCommandOptions = {
  all?: boolean;
  debug?: boolean;
};

export async function applyCommand(
  strategyId: string | undefined,
  opts: ApplyCommandOptions = {},
): Promise<void> {
  const result = bootstrap({ warn: opts.debug ? (m) => console.warn(`boost: ${m}`) : undefined });
  const { db, runner } = result;

  if (opts.all) {
    const candidates = runner.findings.filter(
      (f) => f.category === "clear-wins" && (f.fixes?.length ?? 0) > 0,
    );
    if (candidates.length === 0) {
      process.stdout.write("No clear-win findings to apply.\n");
      return;
    }
    let applied = 0;
    let failed = 0;
    for (const finding of candidates) {
      try {
        await applyOne(db, finding);
        applied += 1;
        process.stdout.write(`✓ applied ${finding.strategyId}: ${finding.title}\n`);
      } catch (err) {
        failed += 1;
        process.stderr.write(`✗ ${finding.strategyId}: ${(err as Error).message}\n`);
      }
    }
    process.stdout.write(`\n${applied} applied, ${failed} failed. Undo any with \"boost revert\".\n`);
    if (failed > 0) process.exit(1);
    return;
  }

  if (!strategyId) {
    process.stderr.write(
      "boost apply: pass a <strategy-id> or use --all to apply every clear-win.\n",
    );
    process.stderr.write('(run "boost" first to see available strategy IDs.)\n');
    process.exit(2);
  }

  const finding = runner.findings.find((f) => f.strategyId === strategyId);
  if (!finding) {
    process.stderr.write(`boost apply: no current finding with strategy id ${JSON.stringify(strategyId)}.\n`);
    process.stderr.write('(run "boost" to see the active findings list.)\n');
    process.exit(2);
  }
  if (!finding.fixes || finding.fixes.length === 0) {
    process.stderr.write(`boost apply: ${strategyId} is advisory — no automated fix to apply.\n`);
    process.exit(2);
  }
  await applyOne(db, finding);
  process.stdout.write(`✓ applied ${finding.strategyId}: ${finding.title}\n`);
  process.stdout.write(`(reversible: "boost revert" undoes it)\n`);
}

async function applyOne(db: import("bun:sqlite").Database, finding: Finding): Promise<void> {
  for (const fix of finding.fixes!) {
    await applyFix(fix, {
      db,
      strategyId: finding.strategyId,
      strategyVersion: finding.strategyVersion,
      predictedSavings: finding.estimatedPercentOfWeeklyUsage,
    });
  }
}
