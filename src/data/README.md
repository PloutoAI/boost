# `src/data/` — ingestion + readers

Two responsibilities:

1. **JSONL pipeline** (`jsonl-discover.ts`, `jsonl-parser.ts`, `jsonl-normalizer.ts`, `jsonl-ingest.ts`) — finds Claude Code session logs, stream-parses them, normalizes messages into rows in `events`, and tracks per-file resume offsets in `jsonl_ingest_state`.
2. **Static config readers** (`claude-md.ts`, `settings-json.ts`, `skills.ts`, `plugins.ts`) — loads the bits of `~/.claude/` that detectors reason about.

The JSONL pipeline is the riskiest code in the project; see `docs/internals/sharp-edges.md` §B15.1 (deduplication) and §B15.5 (JSONC settings.json) before changing anything here.

Path safety lives in `../paths.ts`. Discovery refuses to follow symlinks. The streaming parser caps per-line and per-file sizes (threat model §C3.3, §C3.10).
