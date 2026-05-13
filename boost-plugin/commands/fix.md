---
name: fix
description: Apply a boost finding's fix by strategy id, or apply every clear-win in bulk.
arguments:
  - name: strategyId
    description: "A strategy id (e.g. unused-skill-archive, unused-mcp-disable), or `--all` for every clear-win."
    required: false
---

Parse `$ARGUMENTS` into `strategyId` (or detect `--all`). Then shell out:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs fix $STRATEGY_ID
```

Or for bulk:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs fix --all
```

On success: confirm with the affected files (boost prints them) and remind the user that `/boost:revert` undoes any of them.

On failure (exit 2): surface stderr verbatim. Don't paraphrase. The binary's error messages already point at the right next step — for example, if the strategy requires LLM-synthesised content (claude-md-bloat), it will say so and point at `/boost:trim-claude-md`.

If `$ARGUMENTS` is empty: run the `audit` flow first to show findings, then suggest the right `/boost:fix <id>` invocation.
