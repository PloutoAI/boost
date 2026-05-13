/**
 * `boost fix` — non-interactive CLI for the apply primitive.
 *
 * Two shapes:
 *   - boost fix <strategy-id>   apply every fix on that finding
 *   - boost fix --all           apply every clear-win finding that has a fix
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
  /**
   * Read replacement content from stdin and substitute it as the
   * `newContent` of the strategy's single modify-file fix. Lets a
   * caller (typically a plugin slash command driving an LLM) supply
   * smart content while boost still owns the backup + atomic write +
   * operation record. Requires the strategy to emit exactly one
   * modify-file fix; rejects multi-fix or non-file strategies.
   */
  contentFromStdin?: boolean;
  debug?: boolean;
};

export async function applyCommand(
  strategyId: string | undefined,
  opts: ApplyCommandOptions = {},
): Promise<void> {
  const result = bootstrap({ warn: opts.debug ? (m) => console.warn(`boost: ${m}`) : undefined });
  const { db, runner } = result;

  if (opts.all) {
    const allCandidates = runner.findings.filter(
      (f) => f.category === "clear-wins" && (f.fixes?.length ?? 0) > 0,
    );
    // Split off findings whose fix requires LLM-synthesised content via
    // stdin. Bulk apply can't deliver that — skip with a note so the
    // user knows to run the corresponding skill separately.
    const candidates = allCandidates.filter((f) => !findingRequiresContent(f));
    const skipped = allCandidates.filter((f) => findingRequiresContent(f));
    for (const f of skipped) {
      process.stderr.write(
        `⤳ skipping ${f.strategyId}: requires LLM-synthesised content. Run the matching plugin skill (e.g., \`/boost:trim-claude-md\`).\n`,
      );
    }
    if (candidates.length === 0) {
      const msg = skipped.length > 0 ? "No bulk-applicable clear-wins (see skipped above).\n" : "No clear-win findings to apply.\n";
      process.stdout.write(msg);
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
    process.stdout.write(`\n${applied} applied, ${failed} failed, ${skipped.length} skipped. Undo any with "boost revert".\n`);
    if (failed > 0) process.exit(1);
    return;
  }

  if (!strategyId) {
    process.stderr.write(
      "boost fix: pass a <strategy-id> or use --all to apply every clear-win.\n",
    );
    process.stderr.write('(run "boost" first to see available strategy IDs.)\n');
    process.exit(2);
  }

  const finding = runner.findings.find((f) => f.strategyId === strategyId);
  if (!finding) {
    process.stderr.write(`boost fix: no current finding with strategy id ${JSON.stringify(strategyId)}.\n`);
    process.stderr.write('(run "boost" to see the active findings list.)\n');
    process.exit(2);
  }
  if (!finding.fixes || finding.fixes.length === 0) {
    process.stderr.write(`boost fix: ${strategyId} is advisory — no automated fix to apply.\n`);
    process.exit(2);
  }

  if (findingRequiresContent(finding) && !opts.contentFromStdin) {
    process.stderr.write(
      `boost fix: ${strategyId} requires LLM-synthesised content (the static fix is a placeholder).\n`,
    );
    process.stderr.write(
      `Run the plugin skill that drives this: \`/boost:trim-claude-md\` (or describe what you want — it auto-activates on natural language).\n`,
    );
    process.stderr.write(
      `If you're scripting, pipe the content yourself: \`<content> | boost fix ${strategyId} --content-from-stdin\`.\n`,
    );
    process.exit(2);
  }

  if (opts.contentFromStdin) {
    if (finding.fixes.length !== 1) {
      process.stderr.write(
        `boost fix --content-from-stdin: ${strategyId} has ${finding.fixes.length} fixes; only single-fix strategies support stdin content override.\n`,
      );
      process.exit(2);
    }
    const firstFix = finding.fixes[0];
    if (firstFix?.kind !== "modify-file") {
      process.stderr.write(
        `boost fix --content-from-stdin: ${strategyId}'s fix is "${firstFix?.kind}", not "modify-file" — stdin override is only for content replacements.\n`,
      );
      process.exit(2);
    }
    const stdinContent = await readAllStdin();
    if (stdinContent.length === 0) {
      process.stderr.write(`boost fix --content-from-stdin: stdin was empty; refusing to write an empty file.\n`);
      process.exit(2);
    }
    const overridden: Finding = {
      ...finding,
      fixes: [
        {
          kind: "modify-file",
          payload: {
            filePath: firstFix.payload.filePath,
            newContent: stdinContent,
          },
        },
      ] as unknown as Finding["fixes"],
    };
    await applyOne(db, overridden);
    process.stdout.write(
      `✓ applied ${strategyId}: ${finding.title} (${stdinContent.length} chars from stdin)\n`,
    );
    process.stdout.write(`(reversible: "boost revert" undoes it)\n`);
    return;
  }

  await applyOne(db, finding);
  process.stdout.write(`✓ applied ${finding.strategyId}: ${finding.title}\n`);
  process.stdout.write(`(reversible: "boost revert" undoes it)\n`);
}

function findingRequiresContent(finding: Finding): boolean {
  if (!finding.fixes) return false;
  for (const fix of finding.fixes) {
    if (fix.kind === "modify-file" && fix.payload.requiresContent === true) return true;
  }
  return false;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
