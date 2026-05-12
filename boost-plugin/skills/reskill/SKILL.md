---
description: |
  Use when the user wants to see skill opportunities — which projects they're
  burning the most tokens on without a corresponding Claude Code skill,
  which existing skills have heavy frontmatter to trim, etc. Triggers:
  "reskill", "skill opportunities", "should I make a skill for X",
  "what skills should I create", "boost reskill". This lists candidates;
  for actually drafting a project skill from observed activity, the
  draft-project-skill skill is the one.
allowed-tools:
  - Bash(bun /Users/mouradtrabelsi/.claude/plugins/cache/boost/boost/0.1.0/bin/boost.mjs reskill *)
---

List opportunities — no LLM synthesis needed:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs reskill --json
```

Render the JSON as a numbered list. For each `project-skill` opportunity, show: project path, `$X spend over N sessions and R requests, no skill yet`. Highlight the top one as the highest-leverage move. Suggest `/boost:draft-project-skill <name>` for drafting any of them.

For `skill-trim` opportunities (heavy frontmatter on existing skills), surface the per-skill token cost.

Keep the output tight — this is the menu, not the dish.
