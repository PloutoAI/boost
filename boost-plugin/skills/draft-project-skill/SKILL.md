---
description: |
  Use when the user wants to draft a project-specific Claude Code skill
  from their actual observed activity. Triggers: "draft a skill for X",
  "make a skill for X", "reskill <name>", "boost reskill X",
  "write a SKILL.md for X", "encode my X project conventions",
  "create a project skill for X". The synthesis reads the project's
  files + sample session activity, produces a real SKILL.md following
  Anthropic's canonical format, writes a draft for review.
allowed-tools:
  - Bash(bun:*)
  - Read
  - Write
  - Glob
---

You (Claude) draft a real SKILL.md for the named project based on observed activity. Follow Anthropic's canonical skill conventions (https://code.claude.com/docs/en/skills) — not Memco-style "Activation Triggers / Rules / SOP" ceremony.

### Step 1 — Gather the signal

Get the opportunity:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs reskill --json
```

Find the matching opportunity by the slug the user passed. The opportunity carries `project.project` (absolute path on disk).

Then read only facts you'll encode:
- `README.md` (first 200 lines max) — what this project IS
- `package.json`, `pyproject.toml`, `Makefile`, `justfile` if present — scripts/entrypoints
- 1–2 recent JSONL session files in `~/.claude/projects/` whose `cwd` matches this project (~50 lines each) — for recurring command patterns and tool-use signal

Read aggressively then **discard**. You're authoring instructions Claude itself will load, not writing a report.

### Step 2 — Author the SKILL.md per Anthropic's spec

**Frontmatter** — only what's load-bearing:

```yaml
---
description: <single paragraph, trigger-rich. Example: "Use when working in the velo FastAPI backend (~/w/sandbox/velo) — audit/team/me routes, uvicorn dev server, alembic migrations. Triggers: velo, Plouto, team.plouto.ai, /audit, /me, /team.">
allowed-tools:
  - <ONLY tool patterns the skill genuinely needs without re-prompting>
---
```

- **Omit `name`** — Claude Code defaults it to the directory name.
- **`description` is the activation engine** — pack trigger phrases in. Anthropic explicitly recommends this.
- **`allowed-tools` grants permission (does NOT restrict)**. Only list it if there are stable, repeated tool patterns this project relies on. Otherwise skip the field.
- Never add `disable-model-invocation` or `user-invocable: false`.

**Body** — imperative, freeform markdown, under 500 lines. Anthropic: *"State what to do rather than narrating how or why."*

Recommended sections (drop any you don't have evidence for):

- `# <project-name>` + one prose paragraph: what this project is.
- `## Commands` — for dynamic content (package.json scripts, Makefile targets) use Claude Code's live-injection syntax: a backtick command preceded by a bang. Wrap the actual project path into it — never leave a placeholder. Hardcode commands only for stable conventions (e.g., `uv run` if the project uses uv).
- `## Important files` — `Entry: …`, `Tests: …`, `Config: …`. Real paths, not placeholders.
- `## Conventions` — terse rules from the README and observed patterns. Avoid bullet lists of trivia.
- `## Gotchas` — only if observed evidence shows Claude stumbling repeatedly. Skip if nothing real.

**Do NOT include**:
- `## When to use` — duplicates `description`, wastes tokens on every load.
- `## Activation Triggers` — same.
- Reference material that should live in a separate file (link instead).

### Step 3 — Write the draft

Use `Write` to put the file at `~/.boost/drafts/skills/<name>/SKILL.md`. Create parent dirs.

### Step 4 — Brief the user

Show: the path you wrote to, the trigger phrases in the description, the `allowed-tools` list if any. Tell them:
- Review/edit the draft
- Move it to `~/.claude/skills/<name>/` (or project-scoped `<project>/.claude/skills/<name>/`)
- Restart Claude Code so the skill loads at session start

### Hard constraints

- Only encode observable, stable facts. README beats sessions when they contradict.
- Never include passwords, tokens, API keys, or anything that looks sensitive.
- Keep body under 500 lines. Anthropic's hard ceiling.
- Skip sections rather than fill them with placeholders. Hanging colons are the anti-pattern boost replaces.
