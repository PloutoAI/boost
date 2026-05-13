---
name: outcomes
description: Did your Claude Code spending produce shipped work? Shipped vs abandoned vs unverifiable $.
---

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs yield
```

Emit the output verbatim as your reply. It's already markdown-shaped: header + three buckets (Shipped / Abandoned / Unverifiable) with $ totals and per-session detail.

**Do not add commentary.** boost's output is complete. The "unverifiable" bucket is the one users sometimes ask about — if they do, explain after the output: it covers sessions whose cwd isn't a git repo, was deleted, or relocated since the session ran. Not waste, not shipped — boost can't tell.
