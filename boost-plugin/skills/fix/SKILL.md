---
description: |
  Use when the user wants to apply a boost finding's fix — fix one specific
  strategy, or fix everything safe (the clear-wins) in bulk. Triggers:
  "fix this", "fix <strategy>", "fix the unused MCPs", "fix CLAUDE.md",
  "apply that fix", "apply all", "disable unused MCPs", "archive unused
  skills", "do the boost fixes", "do the clear-wins". For
  `claude-md-bloat`, hands off to the `trim-claude-md` skill which does
  an LLM-driven trim rather than the static stash-and-stub.
allowed-tools:
  - Bash(bun /Users/mouradtrabelsi/.claude/plugins/cache/boost/boost/0.1.0/bin/boost.mjs apply *)
---

Parse the user's request into a strategy id (or `--all`).

**If the strategy id is `claude-md-bloat`** (or the user says "trim my CLAUDE.md", "shrink my global rules", etc.), do not apply via this skill — the `trim-claude-md` skill does a real LLM-driven trim. Tell the user to invoke `/boost:trim-claude-md` or just describe what they want — that skill auto-activates on natural language.

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

Every applied fix is reversible: `/boost:revert` (or `boost revert` in a terminal) undoes any of them. Mention this once at the end.
