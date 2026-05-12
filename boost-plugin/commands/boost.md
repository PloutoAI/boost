---
name: boost
description: Local optimization loop for Claude Code. Find token waste, apply reversible fixes, draft project skills from your actual activity.
arguments:
  - name: action
    description: "check (default) = show findings; apply <id> = apply a finding; apply-all = apply every clear-win; reskill = list skill opportunities; reskill <name> = draft a project skill (LLM-powered); revert = pick an operation to undo; revert <id> = undo a specific op."
    required: false
---

## Instructions

The `boost` binary is bundled with this plugin at `${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs`. It reads `~/.claude/projects/*.jsonl` locally and stores state in `~/.boost/`. No network, no telemetry — except for the `reskill <name>` LLM-drafting path, which uses *this very Claude Code session* (no extra auth needed).

Parse `$ARGUMENTS` into `action` (first word) and `rest` (everything after).

### Default (no action) → show current findings

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs --chat
```

`--chat` produces markdown that's already formatted for in-conversation display. **Print the stdout output verbatim** — do not re-parse, re-format, or add commentary on top. The binary owns the formatting (correct $ math against the uncached denominator, severity badges, apply hints). Re-rendering in the slash command is brittle and was the source of every formatting bug in the early plugin builds.

Exit code is 0 (this is the read-only audit; `--check` is the CI-gate variant that exits 1 on findings).

### /boost apply <strategy-id>

Apply a single finding by strategy ID.

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs apply $STRATEGY_ID
```

If the apply succeeds, confirm to the user with the affected files. If it fails (exit 2), surface the stderr message verbatim — don't paraphrase.

### /boost apply-all

Apply every safe-to-apply clear-win finding in one batch.

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs apply --all
```

Summarise the per-finding ✓/✗ output and remind the user that `boost revert` rolls back any of them.

### /boost reskill (no argument)

List skill opportunities — no LLM needed.

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs reskill --json
```

Render the opportunities as a numbered list. For each `project-skill` opportunity, surface the per-project tokens (`uncachedTokens`, `requests`, `sessions`). Highlight the top one as the highest-leverage move.

### /boost reskill <project-name> — LLM-powered drafting

This is the **plugin-only flow** — the CLI version of this command falls back to a static template.

You (Claude) draft a real SKILL.md based on observed activity. Follow Anthropic's canonical skill conventions (https://code.claude.com/docs/en/skills) — not Memco-style "Activation Triggers / Rules / SOP" ceremony.

#### Step 1 — Gather the signal

Run:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs reskill --json
```

Find the opportunity whose `name` matches the slug the user passed. The opportunity carries `project.project` (absolute path on disk).

Then use the Read tool to gather **only the facts you'll actually encode**:
- `README.md` (first 200 lines max) — what this project IS
- `package.json`, `pyproject.toml`, `Makefile`, `justfile` if present — for scripts/entrypoints
- 1–2 recent JSONL session files in `~/.claude/projects/` whose `cwd` matches this project (~50 lines each) — for recurring command patterns and tool-use signal

Read aggressively then **discard**. You're not writing a report — you're authoring instructions Claude itself will load on every future session.

#### Step 2 — Author the SKILL.md per Anthropic's spec

**Frontmatter** — only what's load-bearing:

```yaml
---
description: <single paragraph; lead with the project's role, then list trigger phrases users would naturally say. Example: "Use when working in the velo FastAPI backend (~/w/sandbox/velo) — Plouto's audit/team/me/operations routes, the uvicorn dev server, the alembic migrations. Triggers: velo, Plouto, team.plouto.ai, /audit, /me, /team, uvicorn velo.main."   Max ~250 words total.>
allowed-tools:
  - <ONLY tool patterns the skill genuinely needs without re-prompting>
  - <e.g., Bash(uv run *), Bash(uvicorn *), Read, Edit — be tight, not generous>
---
```

Notes:
- **Omit `name`** — Claude Code defaults it to the directory name.
- **`description` is the activation engine.** Pack trigger phrases into it. Anthropic explicitly recommends this: *"Include language users would naturally say."*
- **`allowed-tools` grants permission — does NOT restrict.** Only list it if there are stable, repeated tool patterns this project relies on. Otherwise skip the field entirely.
- **Never** add `disable-model-invocation` or `user-invocable: false` — boost-drafted skills should auto-load.

**Body** — imperative, freeform markdown, under 500 lines. Anthropic: *"State what to do rather than narrating how or why."*

Recommended sections (drop any you don't have evidence for):

- `# <project-name>` — one-line: what this project is, written so a fresh Claude session reading it understands within a sentence.
- A short prose paragraph (2–4 sentences) on the project's purpose, stack, where the action is.
- `## Commands` — for dynamic content (package.json scripts, Makefile targets) use Claude Code's live-injection syntax: a backtick command preceded by a bang. Wrap the actual project path into it — never leave a placeholder, the SKILL.md must be ready to run. Example: in the body of a skill for `~/w/sandbox/velo`, you'd embed the literal text consisting of a bang, a backtick, then `cd /Users/.../velo && cat package.json | jq -r '.scripts'`, then a closing backtick. Hardcode commands only for stable conventions (e.g., `uv run` if the project uses uv).
- `## Important files` — `Entry: …`, `Tests: …`, `Config: …`. Real paths from the repo, not placeholders.
- `## Conventions` — terse rules drawn from the README and observed patterns. *"Use uv run for Python; never bare python."* Avoid bullet lists of trivia.
- `## Gotchas` — only if observed evidence shows Claude repeatedly stumbling (failed bash commands, redundant Read calls, retry loops). Skip if nothing real to say.

**Do NOT include**:
- `## When to use` — duplicates `description`, wastes tokens on every session load.
- `## Activation Triggers` — same.
- Any reference material that should live in a separate file (Anthropic: *"Move detailed reference material to separate files"* — link instead).

#### Step 3 — Write the draft

Use Write to put the file at `~/.boost/drafts/skills/<name>/SKILL.md`. Create parent dirs as needed.

#### Step 4 — Brief the user

Show the path you wrote to, summarise the choices you made (especially the trigger phrases in `description`, the `allowed-tools` list if any), and tell them:
- Review/edit the draft
- Move it to `~/.claude/skills/<name>/` (or `<project>/.claude/skills/<name>/` for project-scoped)
- Start a new Claude Code session — skills load at session start

#### Hard constraints

- **Only encode observable, stable facts.** If the README contradicts what you saw in sessions, the README wins (it's authoritative).
- **Never** include passwords, tokens, API keys, or anything that looks like a secret you saw while reading.
- **Keep body under 500 lines.** Anthropic's hard ceiling.
- **Skip a section** rather than fill it with placeholders. A blank `## Common commands` section with `Install: ` and a hanging colon is the anti-pattern boost is supposed to *replace*.

### /boost revert (no argument)

List recent operations.

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs revert --debug 2>&1 | head -25
```

(The CLI is interactive; running it from a slash command, it will print the list then wait for input — we just want the list. Surface it to the user and let them choose with `/boost revert <id>`.)

### /boost revert <operation-id>

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs revert $OP_ID
```

Confirm the revert succeeded.

## Privacy

The bundled binary is 100% local — same offline-only contract as the `@plouto/boost` CLI. The only LLM call in the plugin is the `reskill <name>` path, which runs *inside this Claude Code session* (no separate API key needed, no extra auth). Your data never leaves the machine.
