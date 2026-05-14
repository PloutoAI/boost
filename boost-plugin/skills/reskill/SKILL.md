---
description: |
  Use when the user wants to discover what skills should exist in their Claude
  Code setup — patterns hidden in their actual session content that warrant
  capturing as skills. This is the skill-building skill. Triggers:
  "reskill", "what skills should I have", "discover skills", "find skills",
  "review my skills", "build me skills", "skill ideas", "boost reskill",
  "I keep doing X — should that be a skill", "am I missing any skills".
  Reads session content via Claude (not just boost's SQL bucketing) and
  drafts skills for review.
allowed-tools:
  - Bash(bun:*)
  - Bash(ls:*)
  - Bash(cat:*)
  - Bash(grep:*)
  - Bash(wc:*)
  - Read
  - Write
  - Glob
---

This is the skill-discovery engine. The boost CLI provides a starting fact pack — per-project token spend and which skills are installed — but the real discovery happens by *reading sessions and noticing patterns that warrant skills*. boost's SQL can bucket by `cwd`; only an LLM reading the actual prompts and tool calls can spot:

- **Repeated questions across sessions** — "how does auth work in X" asked 4× → a skill on X's auth
- **Recurring command sequences** — same 5 bash commands at every session start → a workflow skill
- **Persistent context rebuilds** — Claude re-reads the same 8 files every time → those files belong in a project skill's *Important files*
- **Domain terminology that recurs** — user keeps explaining the same internal jargon → a glossary skill
- **Workflows boost ALREADY runs implicitly** — repeated `git ... && bun test ...` patterns the user types fresh each time
- **Skills that should exist as updates, not new** — an existing skill is firing but missing the gotcha you keep hitting

That kind of pattern matching is what makes this skill useful. Without it, you're just rebranding the boost CLI's bucketing.

### Step 1 — Fact pack

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs reskill --json
```

The JSON gives you:
- `installed_skills[]` — current setup (name, frontmatter+body token cost)
- `opportunities[]` — boost's heuristic project-skill candidates (sorted by spend)

This is the **starting signal**, not the answer. Don't just regurgitate it.

### Step 2 — Read recent sessions for real patterns

Pick 3–5 recent JSONL files from `~/.claude/projects/*/` (newest mtime first). For each:

- Read 100–200 lines, not the whole file — sample the conversation flow.
- Note **user prompts** (the `type: "user"` rows) — what questions are being asked? Cluster semantically (auth vs deployment vs debugging vs api-design).
- Note **tool calls** that recur — bash commands, file paths, MCP calls. Sequences are richer signal than individual calls.
- Note **Read/Bash patterns** that repeat across sessions — those files/commands are the user's hot path; they belong in a skill so Claude doesn't rediscover them.

You're scanning for *recurring shapes*, not just counting. A pattern is interesting when:
1. It appears across **multiple sessions** (one-off doesn't earn a skill)
2. It involves **non-obvious knowledge** — *"run `uv run alembic upgrade head` to migrate"* is skill material; *"run tests with `pytest`"* is universal trivia
3. There's **no existing skill** that already covers it (check Step 1's `installed_skills[]`)

### Step 3 — Draft candidate skills

Build up to 3 candidate skills per invocation. Each has a clear **type**:

| Type | What it captures | Example name |
|---|---|---|
| `project` | Per-project conventions, entrypoints, commands | `velo`, `boost`, `loop` |
| `workflow` | Recurring task sequence across projects | `release-checklist`, `deploy-staging`, `pre-pr-review` |
| `tool-pattern` | A specific tool used a specific way | `git-bisect-narrow`, `sqlite-debug-loop` |
| `knowledge` | Reusable domain context (APIs, jargon, conventions) | `plouto-attribution-model`, `claude-code-internals` |
| `update` | Modification to an existing skill (refresh description, add gotcha) | `velo` (existing) |

For each candidate, draft a real SKILL.md following Anthropic's canonical format:

```yaml
---
description: <trigger-rich paragraph; specific phrases the user would say>
allowed-tools:
  - <ONLY tools the skill genuinely needs without re-prompting>
---
```

Body — imperative, freeform markdown, under 500 lines:
- One-paragraph what-this-is
- Concrete commands (use `!`backtick command`` for live-injected dynamic content, hardcode for stable patterns)
- Important files / entrypoints
- Conventions and gotchas, *drawn from observed evidence*

The full per-project recipe is in `draft-project-skill` (`${CLAUDE_PLUGIN_ROOT}/skills/draft-project-skill/SKILL.md`) — read and follow it when drafting a `project` type. For other types, the same principles apply (lean frontmatter, trigger-rich description, imperatives, no ceremony sections).

### Step 4 — Write drafts to `~/.boost/drafts/skills/<name>/SKILL.md`

Create parent dirs as needed. Overwrite prior drafts of the same name.

### Step 5 — Brief the user

Tight:

```
Discovered: N skill candidates from <X> sessions reviewed.

Drafted (~/.boost/drafts/skills/):
  - <name> [project|workflow|tool-pattern|knowledge|update]:
      Evidence: <what you saw — e.g., "auth question repeated across 4 sessions">
      Why it earns a skill: <one line>

Skipped:
  - <name>: <one line — covered by existing skill / one-off / too generic>

Next: review the drafts. Promote keepers to ~/.claude/skills/<name>/
(or <project>/.claude/skills/<name>/ for project-scoped). Restart
Claude Code so they load at session start.
```

If you discovered nothing worth drafting: say so. *Don't* draft for the sake of drafting.

### Hard constraints

- **Evidence-driven** — every drafted skill must cite specific observations from the sessions you read. Not vague claims.
- **No new content** beyond what the sessions evidence. Don't generate generic best-practice rules.
- **Never** include secrets, tokens, paths to credential files, prompt bodies the user typed verbatim, or anything sensitive.
- **No `name` in frontmatter** — directory name wins.
- **`description` is the activation engine** — pack trigger phrases. Specific enough to fire on intent, narrow enough to not over-trigger.
- **Body under 500 lines.** Anthropic's hard ceiling.
- **Drafts only** — never writes directly to `~/.claude/skills/`. The user promotes when satisfied.
- **No more than 3 drafts per invocation.** More overwhelms review; recommend re-running.
