---
description: |
  Use when the user wants to know if their Claude Code spending actually
  produced shipped work — committed code — vs sessions that didn't make
  it to a commit. Triggers: "did my work ship", "was it worth it",
  "outcome attribution", "shipped vs abandoned", "what was wasted",
  "wasted sessions", "abandoned spend", "where did my money go",
  "boost yield", "outcomes". Surfaces the shipped / abandoned /
  unverifiable $ breakdown over the last 7 days, tied to git commits
  in each session's cwd.
allowed-tools:
  - Bash(bun /Users/mouradtrabelsi/.claude/plugins/cache/boost/boost/0.1.0/bin/boost.mjs yield)
---

Run the outcomes report:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs yield
```

Emit the output verbatim as your reply. It's already markdown-shaped: header + three buckets (Shipped / Abandoned / Unverifiable) with $ totals and per-session detail.

**Do not add commentary.** boost's output is complete. The "unverifiable" bucket is the one users sometimes ask about — if they do, explain (after the output): it covers sessions whose cwd isn't a git repo, was deleted, or relocated since the session ran. Not waste, not shipped — boost can't tell.
