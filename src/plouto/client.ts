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

// ── Ingest wire shapes ──────────────────────────────────────────────
// Lean metadata subset of Plouto's /api/ingest/sessions contract. The
// server uses Pydantic `extra="forbid"`, so every field here MUST exist
// in plouto/schemas/ingest.py — we send a subset, never an unknown key.
// All fields are numeric / id / enum / timestamp — never content.

export interface IngestSessionWire {
  id: string;
  cwd: string;
  project_path_encoded: string;
  git_branch?: string | null;
  cli_version?: string | null;
  started_at: string;        // ISO-8601
  ended_at?: string | null;  // ISO-8601
  is_subagent?: number;
  jsonl_path: string;
}

export interface IngestTurnWire {
  uuid: string;
  session_id: string;
  parent_uuid?: string | null;
  is_sidechain?: boolean;
  turn_type: string;         // "user" | "assistant"
  timestamp: string;         // ISO-8601
  model_id?: string | null;
  stop_reason?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  request_id?: string | null;
  iterations?: number;
  speed?: string | null;
  service_tier?: string | null;
}

export interface IngestBatch {
  provider_kind: "claude_code";
  sessions: IngestSessionWire[];
  turns: IngestTurnWire[];
  /** git user.email/name — so the server attributes sessions to the
   *  right engineer instead of the workspace's first user. */
  agent_identity?: { email: string; display_name?: string | null };
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

  /** POST /api/ingest/sessions — returns true on 2xx. Best-effort like
   *  the rest of the client; a failed push just isn't acked, so the
   *  caller leaves its cursor unadvanced and retries next session. */
  async ingestSessions(batch: IngestBatch): Promise<boolean> {
    if (batch.sessions.length === 0 && batch.turns.length === 0) return true;
    try {
      const resp = await fetchWithTimeout(
        `${this.cfg.apiUrl}/api/ingest/sessions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.cfg.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(batch),
        },
        8_000,
      );
      return resp.ok;
    } catch {
      return false;
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
