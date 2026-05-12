---
description: |
  Use when the user asks about Claude Code spending, token waste, weekly usage,
  optimization opportunities, what they should fix, where their tokens are going,
  rate-limit pressure, or wants a general audit. Phrases that trigger:
  "audit", "what's wasting my tokens", "show me my Claude bill",
  "claude usage", "boost", "what should I fix", "am I being efficient",
  "what's my spend", "review my Claude Code usage". Also activated when
  the user explicitly types `/boost:audit` or `/boost:boost` with no action.
allowed-tools:
  - Bash(bun /Users/mouradtrabelsi/.claude/plugins/cache/boost/boost/0.1.0/bin/boost.mjs --chat)
---

Run the boost audit and emit its markdown output verbatim:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs --chat
```

Write the captured stdout as your direct reply — markdown content as your own response text, not as a tool-output block. Claude Code collapses bash output blocks; this stays legible without expansion.

**No preamble. No commentary. No follow-up suggestions.** boost's `--chat` output is complete: it has the spend headline, findings with severity and `≈$X/wk saved`, apply hints (`→ /boost:apply <strategy-id>`), and a "More:" footer pointing at related commands. The output IS the response.

If the user asked an extra question alongside their request, answer that *after* the boost output, separated by a blank line.

Exit code is 0; this is read-only.
