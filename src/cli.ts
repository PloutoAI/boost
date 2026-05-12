#!/usr/bin/env bun
/**
 * boost CLI entrypoint.
 *
 * Surface (kept deliberately small):
 *   boost                interactive TUI (default)
 *   boost reskill [name] skill recommendations and local skill drafts
 *   boost revert [id]    pick or specify an operation to undo
 *
 * Top-level flags:
 *   --json               structured output to stdout
 *   --check[=threshold]  CI gate; exits non-zero on findings ≥ threshold
 *   --debug              full stack traces on errors
 *
 * --check and --json can be combined: JSON goes to stdout AND the exit
 * code follows the check threshold.
 */
import { program } from "commander";
import { bootstrap } from "./orchestrate.ts";
import { buildJson, renderJson } from "./output/json.ts";
import { renderChat } from "./output/chat.ts";
import { buildCheck } from "./output/check.ts";
import { renderPlain, shouldUseColor } from "./output/plain.ts";
import { applyCommand } from "./apply-cli.ts";
import { revertCommand } from "./revert-cli.ts";
import { buildYieldReport, renderYieldReport } from "./output/yield.ts";
import { buildReskillReport, createSkillDraft, renderReskillReport } from "./reskill.ts";
import { summarize, modelUsageLastNDays } from "./summary.ts";
import {
  dailySeries,
  topMcpServers,
  topProjects,
  topTools,
} from "./activity.ts";
import pkg from "../package.json" with { type: "json" };

const ACTIVITY_WINDOW_DAYS = 7;

const VERSION = pkg.version;

program
  .name("boost")
  .description("Local optimization loop for Claude Code usage, context, models, and skills.")
  .version(VERSION)
  .option("--json", "emit structured JSON to stdout")
  .option("--chat", "emit conversation-friendly markdown (used by the plugin)")
  .option("--check", "non-interactive check; non-zero exit on findings ≥ medium severity")
  .option("--debug", "print full stack traces on errors")
  .action(async (opts) => runOptimize(opts, "boost"));

program
  .command("reskill [name]")
  .description("Recommend local skills or create a local skill draft.")
  .option("--json", "emit structured JSON to stdout")
  .option("--debug", "print full stack traces on errors")
  .action(async (name: string | undefined) => {
    const opts = {
      json: process.argv.includes("--json"),
      debug: process.argv.includes("--debug"),
    };
    try {
      const result = bootstrap({ warn: opts.debug ? warnDebug : undefined });
      if (name) {
        const draft = createSkillDraft(name, result.runner.context);
        if (opts.json) process.stdout.write(JSON.stringify(draft) + "\n");
        else process.stdout.write(`${draft.message}\n`);
        return;
      }
      const report = buildReskillReport(result.runner.context);
      if (opts.json) process.stdout.write(JSON.stringify(report) + "\n");
      else process.stdout.write(renderReskillReport(report));
    } catch (err) {
      const msg = (err as Error).message;
      if (opts.debug) console.error(err);
      else console.error(`boost reskill: ${msg}`);
      process.exit(2);
    }
  });

program
  .command("yield")
  .description("Show shipped vs abandoned vs unverifiable $ spend (outcome attribution).")
  .option("--json", "emit structured JSON to stdout")
  .option("--debug", "print full stack traces on errors")
  .action(async (opts: { json?: boolean; debug?: boolean }) => {
    try {
      const result = bootstrap({ warn: opts.debug ? warnDebug : undefined });
      const report = buildYieldReport(result.db, 7, 5);
      if (opts.json) process.stdout.write(JSON.stringify(report) + "\n");
      else process.stdout.write(renderYieldReport(report));
    } catch (err) {
      const msg = (err as Error).message;
      if (opts.debug) console.error(err);
      else console.error(`boost yield: ${msg}`);
      process.exit(2);
    }
  });

program
  .command("apply [strategyId]")
  .description("Apply a finding's fix(es) by strategy ID, or use --all for every clear-win.")
  .option("--all", "apply every safe-to-apply clear-win finding")
  .option("--force", "apply even when the finding's safeToApply is false (still reversible via boost revert)")
  .option("--debug", "print full stack traces on errors")
  .action(async (strategyId: string | undefined, opts: { all?: boolean; force?: boolean; debug?: boolean }) => {
    try {
      await applyCommand(strategyId, opts);
    } catch (err) {
      const msg = (err as Error).message;
      if (opts.debug) console.error(err);
      else console.error(`boost apply: ${msg}`);
      process.exit(2);
    }
  });

program
  .command("revert [operationId]")
  .description("Revert a previously-applied operation.")
  .option("--debug", "print full stack traces on errors")
  .action(async (operationId: string | undefined, opts: { debug?: boolean }) => {
    try {
      await revertCommand(operationId, opts);
    } catch (err) {
      const msg = (err as Error).message;
      if (opts.debug) console.error(err);
      else console.error(`boost revert: ${msg}`);
      process.exit(2);
    }
  });

function warnDebug(m: string): void {
  console.warn(`boost: ${m}`);
}

async function runOptimize(opts: {
  json?: boolean;
  chat?: boolean;
  check?: boolean;
  debug?: boolean;
}, label: string): Promise<void> {
  try {
    const result = bootstrap({ warn: opts.debug ? warnDebug : undefined });
    const { db, runner, totalSavingsPct, ingest } = result;

    if (opts.chat) {
      const out = buildJson(db, runner.findings, totalSavingsPct);
      process.stdout.write(renderChat(out));
      return;
    }

    if (opts.check) {
      const c = buildCheck(runner.findings, summarize(db, totalSavingsPct));
      if (opts.json) {
        // Combined --check + --json: still emit the structured JSON to
        // stdout (CI consumers want both), but exit with the check code
        // so the same invocation gates the build.
        const out = buildJson(db, runner.findings, totalSavingsPct);
        process.stdout.write(renderJson(out) + "\n");
      } else {
        process.stdout.write(c.text);
      }
      process.exit(c.exitCode);
    }

    if (opts.json) {
      const out = buildJson(db, runner.findings, totalSavingsPct);
      process.stdout.write(renderJson(out) + "\n");
      return;
    }

    if (ingest.warnings.length > 0 && opts.debug) {
      for (const w of ingest.warnings) console.warn(w);
    }

    const plainObserved = {
      models: modelUsageLastNDays(db, ACTIVITY_WINDOW_DAYS),
      topTools: topTools(db, ACTIVITY_WINDOW_DAYS, 5),
      topMcpServers: topMcpServers(db, ACTIVITY_WINDOW_DAYS, 5),
      topProjects: topProjects(db, ACTIVITY_WINDOW_DAYS, 4),
      daily: dailySeries(db, ACTIVITY_WINDOW_DAYS),
    };
    process.stdout.write(
      renderPlain(
        runner.findings,
        totalSavingsPct,
        summarize(db, totalSavingsPct),
        plainObserved,
        { color: shouldUseColor() },
      ),
    );
  } catch (err) {
    const msg = (err as Error).message;
    if (opts.debug) {
      console.error(err);
    } else {
      console.error(`${label}: ${msg}`);
      console.error(`(run with --debug for full stack trace)`);
    }
    process.exit(2);
  }
}

program.parseAsync(process.argv);
