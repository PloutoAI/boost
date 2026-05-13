# boost

> **The offline optimization loop for Claude Code.**
> See where tokens are wasted. Apply reversible fixes. Run it again. Watch the waste go down. No TUI, no network, no telemetry, no accounts.

Install in Claude Code (recommended):

```
/plugin install PloutoAI/boost
```

Then `/boost:audit` to see findings, `/boost:fix <strategy-id>` to apply them.

## The loop

```
   observe ── diagnose ── fix ── verify
      ▲                            │
      └─────── revert ─────────────┘
```

boost reads your Claude Code session logs, surfaces the five waste signals below, lets you apply any of them with one keystroke, and lets you undo any fix you regret. Run it weekly, run it in CI, run it before a release — same loop every time.

## What boost spots

- **CLAUDE.md bloat.** Counts the words in your global `CLAUDE.md`. Over 4k words ships overhead with every turn. boost stashes the original and replaces it with a stub.
- **Model-mix imbalance.** If one model is ≥80% of your uncached spend over a week, boost surfaces the breakdown and a cheaper-model escalation path.
- **Retry storms.** Clusters of `api_error` retries in a session, ranked by total back-off wait.
- **Subagent cost share.** Per-session Task() spend as a share of uncached tokens. Surfaces the "every question becomes a Task()" anti-pattern.
- **Auto-compact overuse.** Sessions hitting `auto_compact` 3+ times — context refilled faster than the model can hold it.
- **Unshipped-cost (outcome attribution).** Per-session $ tied to git commits in the session's working directory. Surfaces expensive sessions that never produced a commit — *"$87 in velo, no commits"* — so you can decide if the spend was exploration or waste.
- **No skills installed.** Active user with zero skills → run `boost reskill` to draft project skills from observed activity.
- **Unused MCP / unused skills.** Each connected MCP server ships its full tool schema with every request (~600–1,200 tokens). boost flags servers and skills with no activations in the last 60 days and offers to disable or archive them.

Per-finding output shows projected $ savings (e.g. *"Trim global CLAUDE.md ... -3% · ≈$63/wk"*). Pricing is a bundled snapshot — no network call.

Every fix is a reversible operation. `boost revert` rolls back any of them. The loop closes — and stays closed.

## Privacy

boost is **offline-only**. No network calls. No telemetry. No accounts. No prompt or completion content is persisted, transmitted, or analyzed — the JSONL parser walks files on disk to extract structural metadata (token counts, tool names, model IDs, event timestamps) and discards prompt bytes immediately.

State lives under `~/.boost/`:

- `db.sqlite` — local event log + dedup state
- `backups/` — file backups for revert
- `operations/` — reversible operation audit trail
- `identity.json` — random anonymous IDs (no real machine identifiers)

## Where boost fits

| | boost | [Plouto](https://plouto.ai) | [Memco](https://memco.ai) | [ccusage](https://github.com/ryoppippi/ccusage) | [CodeBurn](https://github.com/getagentseal/codeburn) |
|---|---|---|---|---|---|
| Scope | Individual dev | Engineering team | Cross-tool agents | Individual dev | Individual dev |
| Verb | Optimize | Observe + govern | Remember + replay | Measure | Dashboard |
| Data flow | Local only | SaaS dashboard | Cloud / on-prem memory | Local | Local |
| Fixes config | ✓ | — | — | — | — |
| Reversible | ✓ | — | — | — | — |
| Offline | ✓ | — | — | ✓ | ✓ |
| License | MIT | Free tier + paid | Free tier + $9k/yr | MIT | MIT |

**Quick disambiguation:**
- boost and [Plouto](https://plouto.ai) are siblings. boost is the local optimization loop for the developer at their machine; Plouto is the SaaS that aggregates the same signals across a team and answers the four questions every engineering leader has about AI usage — cost-per-ticket, productivity, resilience, best practices. Use boost on your machine; if your team needs a shared view, Plouto is the upgrade.
- [Memco](https://memco.ai) sits at a different layer — it's a shared memory store that agents call into to skip work they've already done. Complementary, not competing: *Memco remembers what worked; boost optimizes what's still wasting tokens.*
- ccusage and CodeBurn are measurement and dashboard tools — they tell you what your spend looks like. boost is the only one in this comparison that closes the loop by writing to your config, which is also why it ships with the threat model and revert that the others don't need.

## Commands

```
boost                       # print findings (plain text)
boost apply <strategy-id>   # apply one finding's fix
boost apply --all           # apply every safe-to-apply clear-win
boost reskill               # surface skill opportunities from repeated work
boost reskill <name>        # create a local skill draft at ~/.boost/drafts/skills/
boost revert [id]           # pick (or specify) an operation to undo
```

Flags (top-level):

```
--json               # structured JSON to stdout
--check              # non-interactive check; non-zero exit on findings ≥ medium severity
--debug              # full stack traces on errors
```

`--check` and `--json` combine: JSON goes to stdout AND the exit code reflects the check.

`--check` reads your local `~/.claude/projects/*.jsonl` — same as everything else in boost — so it's a fit for local shell hooks (pre-push, cron) on your own machine, not a CI runner gate. CI containers don't have the data.

## Installation

**Inside Claude Code (recommended)** — installs the plugin (binary + slash commands + skills):

```
/plugin install PloutoAI/boost
```

After install, `/boost:audit` to see findings, `/boost:fix <id>` to apply them. Skills like `trim-claude-md`, `reskill`, `draft-project-skill` auto-activate when you describe what you want in natural language.

**As a CLI** (for terminal use, pre-push hooks, scripting):

```sh
git clone https://github.com/PloutoAI/boost.git
cd boost
bun install && bun run build
./bin/boost.mjs
```

Requires Bun ≥ 1.1.0. An npm-published version (`npx @plouto/boost`) is planned but not yet on the registry — pin to a git ref or use the plugin install in the meantime.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For security disclosures, see [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
