---
description: |
  Use when the user wants to undo a previously-applied boost fix. Triggers:
  "revert", "undo", "rollback", "undo that boost change", "boost revert",
  "take back the trim", "restore my CLAUDE.md". If the user names a
  specific operation ID, revert just that; otherwise list recent
  operations and let them pick.
allowed-tools:
  - Bash(bun /Users/mouradtrabelsi/.claude/plugins/cache/boost/boost/0.1.0/bin/boost.mjs revert *)
  - Bash(sqlite3 *)
---

**With operation id:**
```bash
bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs revert <op-id>
```
Confirm the revert succeeded. Mention which file(s) were restored.

**Without operation id** — list recent operations:
```bash
sqlite3 ~/.boost/db.sqlite "SELECT operation_id, strategy_id, applied_at_iso, reverted_at_iso FROM operations ORDER BY applied_at_iso DESC LIMIT 10;"
```
Present as a numbered list with: id (first 8 chars), strategy, applied-at, reverted status. Then ask the user which one to revert, or suggest the most recent active (non-reverted) op as default.

**On failure**: boost's revert refuses if the file's current hash doesn't match the recorded after-hash (i.e., someone modified the file out of band since the apply). Surface stderr verbatim.
