# boost-plugin

The Claude Code plugin distribution of [boost](../) — the reversible config-optimization loop for Claude Code.

## Install

Inside Claude Code:

```
/plugin install PloutoAI/boost
```

Then `/boost:audit` to see findings, `/boost:fix <strategy-id>` to apply one, `/boost:revert` to undo. Skills auto-activate when you describe what you want in natural language (e.g. "trim my CLAUDE.md", "what skills should I have").

A marketplace listing is pending — until then `/plugin install` pulls directly from the GitHub repo.

## What the plugin adds over the bare CLI

The CLI is offline-only and never calls an LLM. **The plugin is where the LLM-using flows live** — they run inside your existing Claude Code session, so they reuse Claude's native tools (Read, Bash, Write) and current auth without spawning subprocesses or asking for a separate API key.

Today's LLM-driven flows:

- **`trim-claude-md`** — reads your global `~/.claude/CLAUDE.md`, reads recent sessions for grounding, drafts a real trim, then routes the change through `boost fix claude-md-bloat --content-from-stdin` (reversible).
- **`reskill`** — reads sessions across projects, clusters recurring patterns the SQL bucketing can't see, drafts skill candidates for review.
- **`draft-project-skill`** — given a project name, drafts a full `SKILL.md` from observed activity following Anthropic's canonical skill conventions.

Every other action (`/boost:audit`, `/boost:fix`, `/boost:revert`, `/boost:outcomes`) is a thin slash-command wrapper that delegates to the bundled `bin/boost.mjs`.

This split is the architectural point: the CLI keeps the trust boundary (cryptographic backups, allowlisted paths, revert); the plugin's skills do the soft work (reading, clustering, drafting). See the [main README](../README.md#how-boost-actually-works--the-dual-engine-pattern) for the dual-engine diagram.

## What's bundled

```
boost-plugin/
├── .claude-plugin/plugin.json
├── commands/
│   ├── audit.md           /boost:audit
│   ├── fix.md             /boost:fix <id>  or  /boost:fix --all
│   ├── revert.md          /boost:revert [id]
│   └── outcomes.md        /boost:outcomes
├── skills/
│   ├── trim-claude-md/    LLM-driven CLAUDE.md trim
│   ├── reskill/           skill-discovery engine
│   └── draft-project-skill/  draft a SKILL.md per project
├── bin/boost.mjs          bundled boost CLI
└── README.md
```

The `bin/boost.mjs` binary is built from the boost repo's `src/cli.ts` via `bun build`. Run `bun run build:plugin` from the boost repo root to refresh it.
