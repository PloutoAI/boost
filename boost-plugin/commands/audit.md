---
name: audit
description: Show current boost findings — Claude Code spend, token waste, optimization opportunities.
---

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs --chat
```

Emit the captured stdout as your direct reply — write the markdown content as your own text response, not as a tool-output block. Claude Code collapses bash output blocks; this stays legible without expansion.

**Do not add anything else.** boost's `--chat` output is complete: spend headline, findings with severity and `≈$X/wk saved`, fix hints (`→ /boost:fix <strategy-id>`), and a "More:" footer pointing at related commands. The output IS the response.

If the user asked an extra question alongside the command, answer that *after* the boost output, separated by a blank line.

Exit code is 0; this is read-only.
