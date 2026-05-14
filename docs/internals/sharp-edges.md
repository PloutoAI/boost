# Sharp Edges

The rakes-in-the-grass. Read before tasks marked "risky."

## B15.1 JSONL deduplication

Naive implementation pitfalls:

- **User messages have no `message.id`.** Identified only by their `event_id` (UUID). Re-ingesting the same JSONL file from earlier byte offset must dedup by `event_id`.
- **Resumed sessions can replay assistant messages with `message_id` set.** These dedup correctly via the unique index.
- **Subagents nest inside parent sessions** but write to their own JSONL. Their messages have unique IDs. They are *not* duplicates.
- **Some assistant messages might be missing `message.id`** (older Claude Code versions, edge cases). Fall back to `event_id`.

Test with: a session, then resume of that session, then `boost` runs after each. Total events should equal unique events.

## B15.2 Token estimation lies

When computing "this fix saves 4,000 tokens per request":

- **The cache is the wild card.** If those 4,000 tokens were already cached, the user's actual cost was ~400 tokens (10% of base). Disabling the cause doesn't save 4,000 — saves the 400 they were paying.
- **Per-request frequency varies wildly.** A user with one session a week sees different savings than one with 30.
- **Prompt structure changes affect what caches.** Trimming CLAUDE.md can paradoxically *increase* short-term cost if the cache had been stable and now must rebuild.

Honest implementation:
- Always show ranges, not points
- Always say "at current rates" or "based on last 7 days"
- Use measured cache hit rate as a discount factor when computing savings
- Lower confidence (and surface it) when usage was atypical that week

## B15.3 Apply flow cursor handling

Naive TUI implementation:
1. User picks finding #2
2. Applies it
3. Re-runs detection
4. Rebuilds list
5. Selection jumps to top, user is disoriented

Better:
1. User picks finding #2
2. Applies it
3. Splice that finding out of the in-memory list
4. Move cursor to what was finding #3 (now #2)
5. Don't re-run detection until user hits `r` or quits

This is fiddly. Test it.

## B15.4 Backup integrity ordering

Tempting: write the modified file, then write the backup. **Don't.**

If your backup write fails halfway (disk full, signal during write), you've corrupted both files. Order: write backup → verify → modify.

Use temp file + atomic rename:
1. Write backup to `<backup-path>.tmp`
2. fsync
3. Rename to `<backup-path>` (atomic on most filesystems)
4. Then modify the original (same temp + fsync + rename pattern)

## B15.5 settings.json is JSON-with-comments

Newer Claude Code versions may write JSONC (JSON with comments) to settings.json. Standard `JSON.parse` will fail.

Use `jsonc-parser`. When writing, preserve comments and formatting if you can — or document that boost will normalize the file on first write.
