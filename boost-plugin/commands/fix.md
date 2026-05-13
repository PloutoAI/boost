---
name: fix
description: Apply a boost finding's fix by strategy id, or apply every clear-win in bulk.
arguments:
  - name: strategyId
    description: "A strategy id (e.g. unused-skill-archive, unused-mcp-disable), or `--all` for every clear-win."
    required: false
---

Parse `$ARGUMENTS` into `strategyId` (or detect `--all`).

**If the strategy is `claude-md-bloat`** (the user named it directly, or `$ARGUMENTS` is empty and the only clear-win finding is claude-md-bloat), do **not** apply via this command. The boost CLI's apply path for it is a static stash-and-stub (theater, not a real fix). Tell the user to invoke `/boost:trim-claude-md` instead — that skill does a real LLM-driven trim, then pipes through the boost apply pipeline (so it's still reversible).

**For every other strategy**, shell out:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs apply $STRATEGY_ID
```

Or for bulk:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs apply --all
```

On success: confirm with the affected files (boost prints them) and remind the user that `/boost:revert` undoes any of them.

On failure (exit 2): surface stderr verbatim. Don't paraphrase.

If `$ARGUMENTS` is empty: run `/boost:audit` first to show findings, then suggest the right `/boost:fix <id>` invocation.
