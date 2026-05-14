---
description: |
  Use when the user wants to shrink, trim, refine, deduplicate, or rewrite
  their global CLAUDE.md (~/.claude/CLAUDE.md). Triggers: "trim CLAUDE.md",
  "my CLAUDE.md is too big", "shrink my global rules", "refine my CLAUDE.md",
  "clean up CLAUDE.md", "boost CLAUDE.md", "apply claude-md-bloat",
  "fix my bloated CLAUDE.md". Performs the LLM-driven trim that the
  CLI's static apply path doesn't — reads the original, drops duplication
  and generic best-practice trivia, keeps idiosyncratic rules, pipes the
  result through boost's reversible apply pipeline.
allowed-tools:
  - Bash(bun:*)
  - Bash(wc:*)
  - Bash(ls:*)
  - Bash(touch:*)
  - Bash(sqlite3:*)
  - Read
  - Write
---

The CLI's static apply for `claude-md-bloat` moves the user's CLAUDE.md to a backup and writes a placeholder. That's theater. You're running inside Claude Code right now — *use Claude to do a real trim.*

### Step 1 — Read the original

Check `~/.claude/CLAUDE.md`:
- If it has substantive content (>200 words and not starting with `# CLAUDE.md (stub)`), that's the source.
- If it's the stub from a prior dumb apply, find the most recent backup at `~/.boost/backups/*.bak` (sort by mtime, newest first) and read THAT as the source. Then plan to revert the stub-apply operation before re-applying — the revert puts the original back so boost can take a fresh backup before your trim.

### Step 2 — Read recent session activity (lightly)

Read 1–2 recent JSONL files in `~/.claude/projects/` (~50 lines each). Look for: which commands the user actually runs, what languages they touch, repeated tool patterns. This grounds the trim in real evidence of which rules are load-bearing.

Don't dwell — this is signal, not the synthesis.

### Step 3 — Synthesize the trim

Target: ~1200–1500 words (Anthropic's recommended budget for the global file).

- **Keep**: rules with "Always"/"Never" language, project-specific conventions, security/compliance, idiosyncratic taste calls (style preferences, em-dash bans, naming quirks).
- **Drop**: generic best practices any developer would already know ("Always use parameterized queries" is universal trivia).
- **Drop**: dead repetitions. CLAUDE.md files often have the same block 3-8× from copy-paste accidents — dedupe to one.
- **Drop**: rules contradicted by observed behaviour. If the README says one thing but the user's sessions consistently do another, the rule is dead.
- **Cluster** by topic; lead with the 2–3 strongest sections.
- **Preserve voice**: terse imperatives → keep terse. Explanatory → keep explanatory. Don't sanitize tone.
- **No new content**. Every line in the output must trace to a line in the input. This is a trim, not a rewrite.

### Step 4 — Apply via boost's pipeline

Write the trimmed content to a tmp file (heredocs with large content via bash are fragile). Then pipe to boost:

```bash
cat /tmp/boost-trim.md | bun ${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs fix claude-md-bloat --content-from-stdin
```

This requires the detector to currently fire (i.e., the file is bloated). If `~/.claude/CLAUDE.md` is already the stub from a prior apply, run `boost revert <op-id>` first (find the op id with `sqlite3 ~/.boost/db.sqlite "SELECT operation_id FROM operations WHERE strategy_id='claude-md-bloat' AND reverted_at_iso IS NULL ORDER BY applied_at_iso DESC LIMIT 1;"`). If the mtime guard blocks (the just-reverted file looks "fresh"), backdate it: `touch -t $(date -v-30d +%Y%m%d%H%M) ~/.claude/CLAUDE.md`.

### Step 5 — Brief the user

Tell them: before-word-count → after-word-count, what categories you kept, what you dropped (one line each), where the backup of the original is (`~/.boost/backups/`), and that `boost revert` (or `/boost:revert`) undoes the trim.

### Hard constraints

- Never include secrets, tokens, paths to credential files, or anything sensitive observed in the source.
- Don't add rules that weren't in the original. Trim, don't regenerate.
- If the original is already <1500 words, refuse — the detector shouldn't have fired and there's no real bloat to trim.
