---
description: |
  Use when the user wants to review and improve their Claude Code skill setup —
  draft skills for projects they're spending heavily on without one, refresh
  skills that aren't activating, or trim skills that have stopped earning their
  token weight. Triggers: "reskill", "review my skills", "what skills should
  I have", "skill opportunities", "are my skills working", "audit my skills",
  "improve my Claude Code skills", "boost reskill". Performs the LLM-driven
  review-and-draft work; the bare `boost reskill --json` menu is just the
  starting fact pack.
allowed-tools:
  - Bash(bun /Users/mouradtrabelsi/.claude/plugins/cache/boost/boost/0.1.0/bin/boost.mjs reskill *)
  - Bash(ls *)
  - Bash(cat *)
  - Bash(wc *)
  - Read
  - Write
  - Glob
---

Don't just list opportunities. Review the user's actual session activity, decide what should change, and *do the work*. Drafts go to `~/.boost/drafts/skills/` for review; the user moves them to `~/.claude/skills/` when satisfied.

### Step 1 — Get the menu

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs reskill --json
```

The JSON gives you:
- `installed_skills[]` — what the user has today (name, frontmatter token cost, body token cost)
- `opportunities[]` — three kinds:
  - `project-skill` — heavy token spend on a project that has no skill yet
  - `skill-trim` — an existing skill with bloated frontmatter
  - `skill-cleanup` — flagged, not yet implemented as a kind

Don't dump this menu at the user. It's input to your review.

### Step 2 — Review existing skills

For each `installed_skills` entry, read `~/.claude/skills/<name>/SKILL.md`. Decide:
- **Activating reliably?** Check the `description` field — is it specific and trigger-rich, or vague? Vague descriptions cause silent skills.
- **Earning its weight?** Frontmatter tokens load every session. If the body is 50 tokens and frontmatter is 400, something is wrong.
- **Still relevant?** Does the project it describes still exist on disk? Are the commands it lists still in the project's package.json?

For each that needs work, draft an updated SKILL.md to `~/.boost/drafts/skills/<name>/SKILL.md` (overwriting any prior draft).

### Step 3 — Review project-skill opportunities

For each `project-skill` opportunity (sorted by uncached tokens, biggest first), decide whether to draft:

- **Threshold for drafting**: the opportunity must show real recurring work. ≥ 8 requests, ≥ 1 session is the detector's bar; you should be tighter — only draft if the project is actually substantial (look at the project on disk: real codebase vs scratch dir? README present? has package.json / pyproject.toml?). Don't draft a skill for `/tmp/scratch`.
- **Draft up to 3 new skills per invocation.** More than that overwhelms review. If there are more candidates, mention them and suggest re-running.
- For each drafted skill, follow the `draft-project-skill` flow:
  - Read README, package.json/pyproject.toml/Makefile
  - Sample 1–2 recent session JSONL files from `~/.claude/projects/` whose `cwd` matches
  - Author a SKILL.md per Anthropic's spec (description trigger-rich, no `name` field, lean body, no ceremony sections)
  - Write to `~/.boost/drafts/skills/<project-slug>/SKILL.md`

The full per-project synthesis recipe lives in the `draft-project-skill` skill (`${CLAUDE_PLUGIN_ROOT}/skills/draft-project-skill/SKILL.md`). Read and follow it for each project you draft.

### Step 4 — Summarise the work

Tell the user, tightly:

```
Reviewed: N existing skills, M project opportunities.

Drafted (N+M new/updated files at ~/.boost/drafts/skills/):
  - <name>: <one-line why>

Skipped:
  - <name>: <one-line why — too small, scratch dir, already covered, etc.>

Next: review the drafts, move keepers to ~/.claude/skills/ (or
<project>/.claude/skills/ for project-scoped), restart Claude Code.
```

If you didn't draft anything: explain why each candidate was skipped. *Don't* draft for the sake of drafting.

### Hard constraints

- **Skills must be specific.** Generic best-practice rules don't belong in a SKILL.md — they bloat every session. Project-specific entrypoints, commands, conventions, gotchas only.
- **Never** include secrets, tokens, paths to credential files, or anything sensitive observed in sessions.
- **No `name` in frontmatter** — directory name is used.
- **`description` is the activation engine** — pack trigger phrases the user would naturally say.
- **Body under 500 lines.** Anthropic's hard ceiling.
- **Drafts only.** Never write directly to `~/.claude/skills/`. The user promotes when ready.
