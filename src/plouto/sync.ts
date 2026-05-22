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
  const response = await client.fetchStrategies();
  if (response === null) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: "skipped", reason: "fetch_failed" }) + "\n");
    } else if (opts.debug) {
      process.stderr.write("plouto-sync: failed to fetch strategies\n");
    }
    return;
  }

  const receipts: AppliedAction[] = [];
  // Older Plouto deploys don't return an ``actions`` array — they only
  // shipped the legacy ``policy_model`` fields. Treat missing as empty
  // so the plugin tolerates straddling a deploy.
  for (const action of response.actions ?? []) {
    const receipt = applyAction(action, { cwd });
    if (sessionId) receipt.session_id = sessionId;
    receipts.push(receipt);
  }

  await client.reportApplied(receipts, sessionId);

  // Summary line — to stderr so it shows up in hook traces but doesn't
  // get fed to the model.
  const counts = receipts.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ") || "no actions";
  if (opts.json) {
    process.stdout.write(JSON.stringify({ status: "ok", counts, receipts }) + "\n");
  } else {
    process.stderr.write(`plouto-sync: ${summary}\n`);
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
