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

Run:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs --chat
```

Then **emit the captured stdout as your direct reply** — meaning, write the markdown content as your own text response, not as a tool-output block. Claude Code's UI collapses bash output blocks; printing the markdown as your reply makes the findings legible without the user having to expand.

**Do not add anything else.** No preamble (*"Output from boost..."*, *"Here are your findings:"*). No summary or commentary at the end (*"The numbers are honest now..."*, *"From here you can..."*). No suggested follow-up commands beyond what boost itself already prints in its "More:" footer. The markdown boost emits is *complete* and self-contained — it has the spend, the findings, the apply hints, and the pointer to `yield` / `reskill`.

If the user asked a separate question alongside `/boost:boost <action>`, answer that *after* the boost output, separated by a blank line.

Exit code is 0 (this is the read-only audit; `--check` is the CI-gate variant that exits 1 on findings).

### /boost apply <strategy-id>

For most strategies, shell out:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs apply $STRATEGY_ID
```
Confirm the affected files on success; on failure (exit 2), surface stderr verbatim.

**Special case: `claude-md-bloat` — call Claude to do a real trim, not the dumb stash-and-stub.**

The CLI's static apply for this strategy moves the user's CLAUDE.md to a backup and replaces it with a placeholder. That's theater — boost is supposed to *fix* the problem, not move it. Inside the plugin you have a Claude session right here; use it.

Steps:

1. **Read the original.** First check whether ~/.claude/CLAUDE.md still has the user's content (>200 words) or is already the stub (5 lines starting with `# CLAUDE.md (stub)`). If it's already the stub, find the most recent backup at `~/.boost/backups/*.bak` (sort by mtime) and read that as the source. Otherwise read `~/.claude/CLAUDE.md` directly.

2. **Read recent session activity** for grounding — the user's actual coding patterns are evidence of which rules are load-bearing. Sample 1–2 recent JSONL files from `~/.claude/projects/`. Read ~50 lines each. Note which commands / tools / paths recur. (Don't dwell — this is signal, not the synthesis.)

3. **Synthesize a real trim.** Goal: produce a CLAUDE.md the user would actually want loaded every session. Cut to ~1200–1500 words (Anthropic's recommended budget for a global file). Apply these rules:
   - **Keep** rules with strong language ("Always", "Never", project-specific conventions), security/compliance items, the user's idiosyncratic taste calls (style preferences, em-dash bans, etc.)
   - **Drop** generic best practices that any developer would already know (e.g., "Always use parameterized queries" is universal trivia, not personal context Claude needs reminded of)
   - **Drop** dead repetitions (the original probably has the same block 4× — boost has seen this pattern in the wild)
   - **Drop** rules contradicted by observed behaviour (if the README says "two-space indent" but you keep using four-space, the rule is dead)
   - **Cluster** by topic — Style / Naming / Error handling / Security / Performance / etc. Lead with the strongest 2–3 sections.
   - **Preserve voice** — if the user writes terse imperatives ("Always handle errors explicitly."), keep that. If they explain ("Always use parameterized queries to prevent SQL injection..."), keep that. Don't sanitize their tone.
   - **No new content.** You're trimming, not rewriting. Every line in the output must trace to a line in the input.

4. **Apply via boost's pipeline** so the change is recorded as a reversible Operation:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs apply claude-md-bloat --content-from-stdin <<'EOF'
   <your trimmed content here>
   EOF
   ```
   boost takes a fresh backup of whatever's currently in ~/.claude/CLAUDE.md (so even if the user already applied the static stub, you can revert all the way back), atomically writes your new content, records an Operation. `boost revert` undoes either the smart trim or restores the original.

5. **Brief the user.** Show: before / after word count, what categories you kept, what you dropped (one line each), and the path to the backup if they want to scan it manually. Tell them `boost revert` undoes this.

**Hard constraints:**
- Never include secrets, tokens, paths to credential files, or anything that looks sensitive that you saw in the original or in sessions.
- Don't add rules that weren't in the original — this is a trim, not a regeneration.
- If the original is <1500 words already, the detector shouldn't have fired; refuse and tell the user.

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
