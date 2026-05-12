# JSON output schema

`boost --json` emits a stable contract that scripts and future UIs can read.

## Schema version 2

```jsonc
{
  "schema_version": 2,
  "generated_at": "2026-05-06T...",
  "summary": {
    "uncached_tokens_last_7_days": 159000000,    // input + output + cache_creation
    "cache_read_tokens_last_7_days": 7700000000, // separate; ~0.1× base price
    "input_tokens_last_7_days":      500000,
    "output_tokens_last_7_days":   7100000,
    "cache_creation_tokens_last_7_days": 152000000,
    "cache_hit_rate_last_7_days":      0.95,     // 0..0.95
    "sessions_last_7_days":              23,
    "total_predicted_savings_pct":       28,
    "rate_limit_pressure": {
      "level": "high",                              // low | medium | high
      "score": 72,                                  // 0..100
      "drivers": ["Opus dominates uncached (94%)"]
    }
  },
  "activity": {
    "window_days": 7,
    "models":          [{"model": "claude-opus-4-7", "uncachedTokens": …, "cacheReadTokens": …, "requests": …}],
    "top_tools":       [{"toolName": "Bash", "mcpServer": null, "count": 663}],
    "top_mcp_servers": [{"server": "github-mcp", "toolCallCount": 35, "distinctTools": 4}],
    "top_projects":    [{"project": "/path/to/repo", "uncachedTokens": …, "cacheReadTokens": …, "requests": …, "sessions": …}],
    "top_sessions":    [{"sessionId": "…", "uncachedTokens": …, "requests": …, "firstAt": "…", "lastAt": "…", "project": "…"}],
    "daily":           [{"date": "2026-05-01", "uncachedTokens": …, "cacheReadTokens": …, "requests": …}]
  },
  "findings": {
    "clear_wins": [/* Finding objects */],
    "trade_offs": [/* Finding objects */]
  },
  "recent_operations": [/* last 5 Operation objects */]
}
```

### `activity` block

Always-on breakdown of the last 7 days. Mirrors what ccusage / tokenuse / CodeBurn put on their default dashboards. Added additively to schema v2 — consumers should ignore the field if they don't recognize it. Window is fixed at 7 days for v0.1; selectable windows are v0.2.

### Why per-token-type fields

Cache reads are billed at ~0.1× base price. Summing them with input/output produces a misleading headline (a 7B-cache-read week looks like a 7B-token week even though the user only paid for ~150M of that). Per-token-type fields let consumers compute their own honest aggregations.

The savings detector denominator is `uncached_tokens_last_7_days` — divide by this when comparing against `estimatedTokensSavedPerRequest × requestsPerWeek`.

## `Finding`

| Field | Type | Notes |
|---|---|---|
| `strategyId` | string | e.g. `"unused-mcp-disable"` |
| `strategyVersion` | int | bumped when the rule logic changes |
| `category` | `"clear-wins" \| "trade-offs"` | |
| `severity` | `"high" \| "medium" \| "low"` | |
| `safeToApply` | bool | reasonable as a one-keystroke action |
| `title` | string | rendered headline |
| `affectedItems` | string[] | servers, paths, etc. |
| `estimatedTokensSavedPerRequest` | int | conservative point estimate |
| `estimatedPercentOfWeeklyUsage` | number \| null | null when cold-start |
| `evidence` | object | structured evidence |
| `evidence.observedAtIso` | string | ISO timestamp |
| `evidence.windowDays` | int | observation window |
| `evidence.signals` | object | strategy-specific |
| `evidence.humanReadable` | string | one-line summary |
| `fixes` | non-empty array | each entry discriminated by `kind`. Multiple fixes apply sequentially as separate Operations. |

## `Operation`

| Field | Type | Notes |
|---|---|---|
| `operationId` | uuid | |
| `strategyId` | string | |
| `strategyVersion` | int | |
| `appliedAtIso` | string | |
| `revertedAtIso` | string \| null | null while active |
| `source` | `"built-in"` | |
| `beforeHash` | hex string | sha256 of pre-state |
| `afterHash` | hex string | sha256 of post-state |
| `backupRef` | object | discriminated by `kind` |
| `predictedSavingsPercent` | number \| null | |

## Stability

`schema_version` ticks if any of the above shapes change in a breaking way.
Additive changes (new optional fields) do not bump the version. Consumers should
ignore unknown fields.

### Migration from v1 → v2

The summary block changed shape:

| v1 | v2 |
|---|---|
| `tokens_last_7_days` | (removed) — sum `uncached_tokens_last_7_days + cache_read_tokens_last_7_days` if you want the old number, but you probably don't |
| — | `uncached_tokens_last_7_days` |
| — | `cache_read_tokens_last_7_days` |
| — | `input_tokens_last_7_days`, `output_tokens_last_7_days`, `cache_creation_tokens_last_7_days` |
| — | `cache_hit_rate_last_7_days` |
