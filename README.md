# boost

> **The reversible config-optimization loop for Claude Code.**
> boost detects token waste in your Claude Code sessions, applies fixes with cryptographic backups, and — when a fix needs language synthesis — drives Claude itself via plugin skills to do the rewriting. boost owns trust; Claude owns taste. Offline, no network, no accounts.

## Install

Inside Claude Code (recommended):

```
/plugin install PloutoAI/boost
```

Then `/boost:audit` to see findings, `/boost:fix <strategy-id>` to apply one, `/boost:revert` to undo. Skills like `trim-claude-md`, `reskill`, and `draft-project-skill` auto-activate when you describe what you want in natural language.

## How boost actually works — the dual-engine pattern

boost is two cooperating engines meeting at a `stdin` seam:

```
  Claude Code sessions  (~/.claude/projects/*.jsonl)
        │
        ▼
  ┌──────────────────────┐
  │ boost CLI            │   deterministic substrate
  │  detect waste        │     SQL + heuristics
  │  rank findings       │     SHA-256 backup + revert
  │  apply (reversible)  │     offline, no network
  └─────────┬────────────┘
            │  fix needs language synthesis?
            ▼
  ┌──────────────────────┐
  │ Plugin skill         │   probabilistic engine
  │  reads sessions      │     Claude does the soft work
  │  drafts content      │     driven by SKILL.md
  │  pipes to boost      │     brings its own LLM
  └─────────┬────────────┘
            │  cat trim.md | boost fix … --content-from-stdin
            ▼
  ┌──────────────────────┐
  │ boost CLI            │   back to deterministic
  │  validates input     │     for the write boundary
  │  backs up + applies  │
  │  records operation   │     (later: boost revert)
  └──────────────────────┘
```

The CLI never calls an LLM. The skill never writes to your config directly — it drafts, then routes the change through boost's apply path. boost trusts the LLM to write good prose; the LLM trusts boost to handle integrity, backup, and revert.

That split is the whole point. Most cost tools either measure (and stop) or move data to a SaaS dashboard. boost is the only OSS tool that closes the loop by writing reversibly to your config — and the only one whose architecture is built around the soft/hard split that real config optimization requires.

## What it does today

`/boost:audit` shows findings tagged for what you can do with them:

**▶  Reversible fixes** — apply with `/boost:fix <id>`, undo with `/boost:revert`:

- **`claude-md-bloat`** — your global `CLAUDE.md` is over 4k words. The `trim-claude-md` skill does the actual rewrite using Claude; the CLI applies + makes it revertible.
- **`unused-mcp-disable`** — flags MCP servers with no activations in 60 days. CLI sets `mcpServers.X.disabled = true` directly.
- *(`unused-skill-archive` exists too but is dormant pending Claude Code's OTel signal in v0.2.)*

**·  Advisories** — no automated fix, just signal:

- Model-mix imbalance (≥80% of weekly spend in one model)
- Retry storms (clustered `api_error` retries per session)
- Subagent cost share (Task() spend share of session uncached tokens)
- Auto-compact overuse (≥3 compacts per session)
- Unshipped-cost — session $ tied to git commits; flags expensive sessions that produced no shipped work
- Verbose shell output — Bash responses eating meaningful weekly share; points at [rtk](https://github.com/rtk-ai/rtk) for that layer
- No skills installed — run `boost reskill` to draft project skills from observed activity

Each finding shows projected $ savings against a bundled price table (no network call).

## Where boost sits in the stack

Different tools own different layers. boost owns the **structural-fix** layer — what's in `CLAUDE.md`, which MCP servers are loaded, what skills you've installed.

| Layer | Tools | Mechanism |
|---|---|---|
| Runtime shell output | [rtk](https://github.com/rtk-ai/rtk) | Intercepts CLI commands; compresses output before Claude reads it |
| In-product cost | Claude Code's `/cost`, `/usage`, `/context` | Native; live numbers, no install |
| Session measurement | [ccusage](https://github.com/ryoppippi/ccusage), [CodeBurn](https://github.com/getagentseal/codeburn) | Read logs; show numbers; no writes |
| Team observability | [Plouto](https://plouto.ai), SaaS dashboards | Aggregate across users; team-level governance |
| Agent memory | [Memco](https://memco.ai) | Replay prior agent solutions; skip redoing work |
| **Structural config fixes** | **boost** | **Detect waste in logs; write config reversibly via deterministic CLI + skill-mediated synthesis** |

They stack. A heavy Claude Code user might reasonably run rtk + boost (rtk shrinks per-command output; boost trims structural overhead), glance at ccusage for the headline number, and ignore the rest.

**On native Claude Code obsolescence risk.** Anthropic could ship `/cost --insights` tomorrow and absorb some of boost's detectors. The detectors aren't the moat; the moat is the *substrate*: reversible writes with cryptographic integrity, plus the dual-engine pattern that lets Claude do creative work on your config without giving Claude the filesystem keys. That part is harder to absorb because it's an architectural choice, not a feature.

**On Plouto positioning.** boost and [Plouto](https://plouto.ai) are siblings under the same org. boost is the local loop for the developer at their machine; Plouto is the SaaS that aggregates the same signals across a team. Use boost on your machine; reach for Plouto if your team needs a shared view.

## Privacy

boost is **offline-only**. No network calls. No telemetry. No accounts. The JSONL parser walks files on disk to extract structural metadata (token counts, tool names, model IDs, event timestamps) and discards prompt bytes immediately. State lives under `~/.boost/`:

- `db.sqlite` — local event log + dedup state
- `backups/` — file backups for revert (SHA-256 integrity)
- `operations/` — reversible operation audit trail
- `identity.json` — random anonymous IDs (no real machine identifiers)

See [docs/internals/threat-model.md](docs/internals/threat-model.md) for the full security model and known open gaps.

## Commands

```
boost                       # print findings (plain text)
boost fix <strategy-id>     # apply one finding's reversible fix
boost fix --all             # apply every safe-to-apply clear-win
boost reskill               # surface skill opportunities from repeated work
boost reskill <name>        # create a local skill draft at ~/.boost/drafts/skills/
boost revert [id]           # pick (or specify) an operation to undo
boost outcomes              # session $ correlated to shipped commits
```

Top-level flags:

```
--json               # structured JSON to stdout
--check              # non-interactive; non-zero exit on findings ≥ medium severity
--debug              # full stack traces on errors
```

`--check` + `--json` combine: JSON to stdout and exit code reflects the check. `--check` reads `~/.claude/projects/*.jsonl` locally — fit for shell hooks (pre-push, cron) on your own machine, not a CI runner gate. CI containers don't have the data.

## Installation

**Inside Claude Code (recommended)** — installs the plugin (binary + slash commands + skills):

```
/plugin install PloutoAI/boost
```

After install: `/boost:audit` to see findings, `/boost:fix <id>` to apply, `/boost:revert` to undo. Skills auto-activate when you describe what you want in natural language.

**As a CLI** (terminal use, pre-push hooks, scripting):

```sh
git clone https://github.com/PloutoAI/boost.git
cd boost
bun install && bun run build
./bin/boost.mjs
```

Requires Bun ≥ 1.1.0. An npm-published version (`npx @plouto/boost`) is planned but not yet on the registry — pin to a git ref or use the plugin install in the meantime.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security disclosures: [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
