---
name: revert
description: Undo a previously-applied boost fix. Lists recent operations if no id is given.
arguments:
  - name: operationId
    description: "Optional. The operation id to revert. If omitted, lists recent operations and asks which to undo."
    required: false
---

**If `$ARGUMENTS` has an operation id:**

```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs revert $OPERATION_ID
```

Confirm the revert succeeded; mention which file(s) were restored.

**If `$ARGUMENTS` is empty**, list recent operations:

```bash
sqlite3 ~/.boost/db.sqlite "SELECT operation_id, strategy_id, applied_at_iso, reverted_at_iso FROM operations ORDER BY applied_at_iso DESC LIMIT 10;"
```

Present as a numbered list: id (first 8 chars), strategy, applied-at, reverted status. Ask the user which to revert, or suggest the most recent active (non-reverted) op as default.

**On failure**: boost's revert refuses if the file's current hash doesn't match the recorded after-hash (someone modified the file out of band since the apply). Surface stderr verbatim.
