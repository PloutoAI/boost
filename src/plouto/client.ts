/**
 * Thin HTTP client for the Plouto plugin endpoints.
 *
 * Three calls exist today:
 *   GET  /api/plugin/strategies          → action list + legacy fields
 *   POST /api/plugin/strategies/applied  → per-strategy enforcement receipts
 *   POST /api/plugin/setup               → engineer-local config snapshot
 *
 * The client intentionally does NOT throw on network errors at the
 * call-site level — SessionStart enforcement is best-effort and
 * blocking Claude Code startup on Plouto being unreachable would be
 * unacceptable. Callers receive ``null`` or empty stats and decide
 * how loudly to complain.
 */

import type { PloutoConfig } from "./config.ts";

export interface StrategyAction {
  strategy_id: string;
  kind: string;
  target: string;
  mode: string;
  op: string;                // install | remove | recommend | no-op
  source: string | null;
  rollout_pct: number;
  in_cohort: boolean;
  rationale: string;
}

export interface StrategiesResponse {
  policy_model: string | null;
  policy_text: string | null;
  rollout_pct: number;
  in_cohort: boolean;
  skills_repo_url: string | null;
  /**
   * Optional — older Plouto versions only return the legacy
   * ``policy_model`` family of fields and omit ``actions`` entirely.
   * Callers must tolerate both shapes.
   */
  actions?: StrategyAction[];
  generated_at: string;
}

export interface AppliedAction {
  strategy_id: string;
  kind: string;
  target: string;
  op: string;
  status: "applied" | "failed" | "skipped" | "out_of_cohort";
  error?: string;
  session_id?: string;
  /**
   * Set when the action ran through boost's reversible apply substrate —
   * the local `operations` row id, so `boost revert <id>` can undo it and
   * Plouto can surface "revertable" in the rollout view. Absent for the
   * still-direct install path and for skipped/failed receipts.
   */
  operation_id?: string;
}

const REQUEST_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class PloutoClient {
  constructor(private readonly cfg: PloutoConfig) {}

  /** GET /api/plugin/strategies — returns null on any error. */
  async fetchStrategies(): Promise<StrategiesResponse | null> {
    try {
      const resp = await fetchWithTimeout(
        `${this.cfg.apiUrl}/api/plugin/strategies`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${this.cfg.token}` },
        },
      );
      if (!resp.ok) return null;
      const data = (await resp.json()) as StrategiesResponse;
      return data;
    } catch {
      return null;
    }
  }

  /** POST /api/plugin/strategies/applied — returns true on 2xx. */
  async reportApplied(
    receipts: AppliedAction[],
    sessionId?: string,
  ): Promise<boolean> {
    if (receipts.length === 0) return true;
    try {
      const resp = await fetchWithTimeout(
        `${this.cfg.apiUrl}/api/plugin/strategies/applied`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.cfg.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ session_id: sessionId, receipts }),
        },
      );
      return resp.ok;
    } catch {
      return false;
    }
  }
}
