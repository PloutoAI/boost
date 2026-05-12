# boost-plugin

The Claude Code marketplace distribution of [boost](../) — the offline optimization loop for Claude Code.

## Install

Coming soon — pending marketplace listing. For now, clone the boost repo and install boost via npm/bun:

```sh
bun add -g @plouto/boost
```

Then use the CLI directly: `boost`, `boost apply <id>`, `boost reskill`, `boost revert`.

## What this plugin adds over the CLI

The CLI is offline-only by construction. **The plugin is the natural home for any LLM-using feature in boost** — it runs inside an existing Claude Code session, so it can use Claude's native tools (Read, Bash, Write) and current auth without spawning subprocesses or asking for a separate API key.

Today, the one LLM-powered flow is:

- `/boost reskill <project>` — Claude reads your session activity for that project, reads the project's actual files, and drafts a populated SKILL.md tailored to the observed patterns. The CLI version of this command falls back to a static template.

Every other action (`/boost`, `/boost apply`, `/boost revert`, etc.) is a thin wrapper that delegates to the bundled `bin/boost.mjs`.

## What's bundled

```
boost-plugin/
├── .claude-plugin/plugin.json
├── commands/boost.md          # /boost slash command (action-dispatched)
├── bin/boost.mjs              # bundled boost CLI (see build:plugin script)
└── README.md
```

The `bin/boost.mjs` binary is built from the boost repo's main `src/cli.ts` via `bun build`. Run `bun run build:plugin` from the boost repo root to refresh it.
