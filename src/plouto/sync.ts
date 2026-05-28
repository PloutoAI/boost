/**
 * ``boost plouto-sync`` — fetch, apply, report.
 *
 * Invoked by the SessionStart hook with Claude Code's hook payload on
 * stdin (so we can extract session_id for the apply receipts). The
 * command:
 *
 *   1. Loads PloutoConfig — silently exits 0 if not configured.
 *   2. Fetches /api/plugin/strategies.
 *   3. Iterates the actions; applies each one locally; collects receipts.
 *   4. POSTs the receipts back to /api/plugin/strategies/applied.
 *   5. Prints a one-line summary to stderr (so the hook trace shows
 *      what happened without polluting Claude Code's own stdout).
 *
 * Exit codes: always 0 unless --debug is set and an internal panic
 * occurs. The hook is best-effort; making Claude Code startup
 * fragile on our behalf is unacceptable.
 */

import { applyAction } from "./enforce.ts";
import { PloutoClient, type AppliedAction } from "./client.ts";
import { loadPloutoConfig } from "./config.ts";
import { LoopDatabase } from "../db.ts";
import { runIngestSync, type IngestSyncResult } from "./ingest.ts";

interface HookInput {
  session_id?: string;
  cwd?: string;
}

export interface SyncOptions {
  json?: boolean;
  debug?: boolean;
}

export async function runPloutoSync(opts: SyncOptions = {}): Promise<void> {
  const stdinJson = await _readStdinJson<HookInput>();
  const sessionId = stdinJson?.session_id;
  const cwd = stdinJson?.cwd ?? process.cwd();

  const cfg = loadPloutoConfig();
  if (!cfg) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: "skipped", reason: "not_configured" }) + "\n");
    } else if (opts.debug) {
      process.stderr.write("plouto-sync: PLOUTO_TOKEN not set, skipping\n");
    }
    return;
  }

  const client = new PloutoClient(cfg);

  // boost's local DB backs both halves: the ingest cursor AND the
  // enforcement apply substrate. Open it best-effort — if unavailable,
  // skip this sweep rather than break Claude Code startup; next retries.
  let loopDb: LoopDatabase;
  try {
    loopDb = LoopDatabase.open();
  } catch (err) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: "skipped", reason: "db_unavailable" }) + "\n");
    } else if (opts.debug) {
      process.stderr.write(`plouto-sync: db open failed, skipping: ${(err as Error).message}\n`);
    }
    return;
  }

  let ingest: IngestSyncResult | null = null;
  const receipts: AppliedAction[] = [];
  try {
    // (1) Push session metadata up. Independent of enforcement — runs
    // even if the strategies fetch fails. Best-effort; never throws.
    try {
      ingest = await runIngestSync(loopDb.db, client, {
        warn: opts.debug ? (m) => process.stderr.write(`plouto-sync: ${m}\n`) : undefined,
      });
    } catch (err) {
      if (opts.debug) process.stderr.write(`plouto-sync: ingest error: ${(err as Error).message}\n`);
    }

    // (2) Pull strategies + enforce. A missing/failed fetch just skips
    // enforcement; the ingest above still happened. Older Plouto deploys
    // omit ``actions`` (legacy policy_model only) — treat as empty.
    const response = await client.fetchStrategies();
    if (response !== null) {
      for (const action of response.actions ?? []) {
        const receipt = await applyAction(action, { cwd, db: loopDb.db });
        if (sessionId) receipt.session_id = sessionId;
        receipts.push(receipt);
      }
    }
  } finally {
    loopDb.close();
  }

  if (receipts.length > 0) await client.reportApplied(receipts, sessionId);

  // Summary → stderr (shows in hook traces, not fed to the model).
  const counts = receipts.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const enforceSummary =
    Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no actions";
  const ingestSummary = ingest
    ? `ingest ${ingest.turnsUploaded} turns / ${ingest.filesUploaded} files${ingest.hitRunCap ? " (capped, more next session)" : ""}`
    : "ingest skipped";
  if (opts.json) {
    process.stdout.write(JSON.stringify({ status: "ok", counts, receipts, ingest }) + "\n");
  } else {
    process.stderr.write(`plouto-sync: ${enforceSummary}; ${ingestSummary}\n`);
  }
}

/**
 * Read JSON from stdin if present, else return null. Times out after
 * 250ms — Claude Code feeds hook input synchronously, so anything not
 * delivered fast means there's no payload (e.g. manual ``boost
 * plouto-sync`` invocation).
 */
async function _readStdinJson<T>(): Promise<T | null> {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (val: T | null) => {
      if (done) return;
      done = true;
      resolve(val);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => {
      if (!buf.trim()) {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(buf) as T);
      } catch {
        finish(null);
      }
    });
    setTimeout(() => finish(null), 250);
  });
}
