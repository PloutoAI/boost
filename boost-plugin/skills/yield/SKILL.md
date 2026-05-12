---
description: |
  Use when the user wants outcome attribution — what they spent on Claude
  Code sessions that actually shipped (commits landed) vs sessions that
  produced nothing. Triggers: "yield", "did my work ship", "abandoned
  spend", "boost yield", "what was wasted", "shipped vs abandoned",
  "wasted sessions", "outcome attribution". Surfaces the shipped /
  abandoned / unverifiable $ breakdown over the last 7 days.
allowed-tools:
  - Bash(bun /Users/mouradtrabelsi/.claude/plugins/cache/boost/boost/0.1.0/bin/boost.mjs yield)
---

Run the yield report:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs yield
```

Emit the output verbatim as your reply. It's already markdown-shaped: header + three buckets (Shipped / Abandoned / Unverifiable) with $ totals and per-session detail.

**Do not add commentary.** boost's output is complete. The "unverifiable" bucket is the one users sometimes ask about — if they do, explain (after the output): it covers sessions whose cwd isn't a git repo, was deleted, or relocated since the session ran. Not waste, not shipped — boost can't tell.
