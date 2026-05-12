---
description: |
  Use when the user wants to apply a specific boost finding's fix, or apply
  every clear-win in bulk. Triggers: "apply <strategy-id>", "apply all",
  "fix this", "fix <strategy>", "disable unused MCPs", "archive unused skills",
  "do the boost fixes", "apply boost findings". Pass-through for any
  strategy *except* `claude-md-bloat` — for that one, the `trim-claude-md`
  skill does an LLM-driven trim instead. Dispatch there if the user names
  claude-md-bloat or asks to trim their CLAUDE.md.
allowed-tools:
  - Bash(bun /Users/mouradtrabelsi/.claude/plugins/cache/boost/boost/0.1.0/bin/boost.mjs apply *)
---

Parse the user's request into a strategy id (or `--all`).

**If the strategy id is `claude-md-bloat`**, do not apply via this skill — the trim-claude-md skill does a real LLM-driven trim. Tell the user to invoke `/boost:trim-claude-md` (or just describe what they want — that skill activates on natural language too).

**For everything else**, shell out:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs apply <strategy-id>
```

Or for bulk:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs apply --all
```

On success: confirm with the affected files (boost prints them).
On failure (exit 2): surface stderr verbatim. Don't paraphrase.

Every applied fix is reversible: `boost revert` (or `/boost:revert`) undoes any of them. Mention this once at the end if a destructive-sounding fix was applied.
