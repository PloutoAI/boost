# Writing a strategy

A strategy is a small TypeScript module that:

1. Looks at the user's behavior (events) and config (snapshot).
2. Decides whether there's a worthwhile, reversible improvement.
3. Returns a `Finding` describing it, including one or more `Fix` payloads.

A "good" strategy is **reversible, evidence-based, conservative, honest about uncertainty, and tested.**

## What's in `DetectorContext`

The runner builds and passes a `DetectorContext` (see `src/strategy.ts`):

```ts
type DetectorContext = {
  events: { db: Database };       // SQLite event log; query directly
  config: ConfigSnapshot;          // CLAUDE.md files, settings.json, skills, plugins
  now: Date;                       // captured once per detection run
  recentDismissals: Set<string>;   // strategy IDs to skip (handled by runner)
  daysOfDataAvailable: number;     // cold-start gate; 0 means first-run
};
```

Useful columns in `events`:
- `event_type`: `"api_request"`, `"tool_use"`, `"tool_result"`, `"user_message"`, `"skill_activated"` (the last is OTel-only and v0.2+).
- `timestamp_iso`: ISO 8601, ascending.
- `payload_json`: strategy-specific. For `api_request`, contains `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`, `model`, `cwd`, `git_branch`. For `tool_use`, contains `tool_name`, `tool_use_id`, `mcp_server_name`.

Use `json_extract(payload_json, '$.field')` in queries.

`ConfigSnapshot` (`src/strategy.ts`) holds the result of the static config readers:
- `claudeMdFiles: ClaudeMdFile[]` — global + project + memory, with `wordCount`/`estimatedTokens`/`imports`.
- `settings: ClaudeSettings | null` — parsed `~/.claude/settings.json`. `null` if missing or invalid.
- `skills: Skill[]` — installed skills with `mtimeMs` for grace-period checks.
- `plugins: Plugin[]` — top-level plugin directories.

## Anatomy

```ts
import type { Finding, Fix } from "../types.ts";
import type { StrategyDefinition } from "../strategy.ts";
import { weeklySavingsPct } from "../summary.ts";

const id = "my-detector";
const version = 1;

const strategy: StrategyDefinition = {
  id,
  version,
  category: "clear-wins",
  defaultSeverity: "medium",
  safeToApply: true,
  title: (f) => `Do the thing for ${f.affectedItems.length} items`,
  detect: (ctx) => {
    if (ctx.daysOfDataAvailable < 14) return null;
    // Look at ctx.config and ctx.events.db; build a list of items to act on.
    const items: string[] = []; /* ... */
    if (items.length === 0) return null;

    const tokensPerRequest = items.length * 250;
    const fixes: Fix[] = items.map((name) => ({
      kind: "modify-settings-key",
      payload: { filePath: ctx.config.settings!.path, jsonPath: `someKey.${name}.disabled`, newValue: true },
    }));

    return {
      strategyId: id,
      strategyVersion: version,
      category: "clear-wins",
      severity: items.length >= 3 ? "high" : "medium",
      safeToApply: true,
      title: "",
      affectedItems: items,
      estimatedTokensSavedPerRequest: tokensPerRequest,
      estimatedPercentOfWeeklyUsage: weeklySavingsPct(ctx.events.db, tokensPerRequest),
      evidence: {
        observedAtIso: ctx.now.toISOString(),
        windowDays: 60,
        signals: { items },
        humanReadable: `${items.length} items match the rule.`,
      },
      fixes: fixes as readonly [Fix, ...Fix[]],
    };
  },
  explain: (f) => `Long-form prose for the detail view.`,
};

export default strategy;
```

Then add it to `src/strategies/index.ts` (alphabetical).

## Worked example

Suppose you want to flag MCP servers whose names end in `-staging` once they haven't been used in 30 days. Steps:

1. Copy `src/strategies/unused-mcp-disable.ts` to `src/strategies/disable-staging-mcp.ts`.
2. Change `id`, narrow the `for (const server of …)` loop with an `endsWith("-staging")` filter, drop the window to 30 days.
3. Add to the registry.
4. Write `tests/strategies/disable-staging-mcp.test.ts`. Use the helpers in `tests/helpers/detector-context.ts`:
   ```ts
   const ctx = makeDetectorContext({
     daysOfDataAvailable: 30,
     settings: fakeSettings({ filePath: ..., servers: [{ name: "prod" }, { name: "preview-staging" }] }),
     seed: (db) => { seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() }); },
   });
   const finding = strategy.detect(ctx.ctx);
   expect(finding!.affectedItems).toEqual(["preview-staging"]);
   ```
5. Add a CHANGELOG entry under `Unreleased`.

## Criteria for a good strategy

- **Reversible.** Every `Fix` you produce must round-trip through `applyFix` + `revertOperation` without data loss. If you can't write the inverse, you can't ship the operation.
- **Evidence-based.** Behavioral signals (event counts, timestamps), not heuristic thresholds alone. "Server hasn't been called in 60 days" beats "server name matches a list".
- **Conservative.** False positives are expensive. Require a strong signal before flagging. Use cold-start gates (`daysOfDataAvailable < N`).
- **Honest about uncertainty.** Use `weeklySavingsPct(db, tokensPerRequest)` rather than computing percentages by hand — it clamps to ≤ 99.9 and discounts by the measured cache hit rate. Mark `safeToApply: false` for advisory checks that need human review.
- **Tested.** Cold-start, severity boundaries, no-signal skips, and at least one positive case. Use the `seed*` helpers in `tests/helpers/detector-context.ts`.

## Submitting a PR

- Open an issue describing the rule first.
- Reference the issue in the PR.
- Include a CHANGELOG entry under "Unreleased".
- Update the README's "What it does" examples if the new strategy is user-visible.
- Read [`docs/internals/threat-model.md`](internals/threat-model.md) if your fix touches a new file path or directory.
