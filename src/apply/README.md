# `src/apply/` — backup, apply, revert

Three concerns:

- **`backup.ts`** — generic backup-before-write helper. Three kinds: file, settings-key, directory. Atomic writes (temp + fsync + rename), no symlink follow, sha256 hashing for integrity.
- **`apply.ts`** — generic `applyFix` executor. Backups, race detection (mtime/size), rollback on failure, persistent operation record.
- **`revert.ts`** — generic `revertOperation`. Reads the recorded backup, verifies hash matches `beforeHash`, restores.

Read [`docs/internals/sharp-edges.md`](../../docs/internals/sharp-edges.md) §B15.4 (backup ordering) before changing anything here. The threat model section §C3 covers each safety property the code implements.
