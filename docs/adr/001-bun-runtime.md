# ADR 001: Bun runtime

**Status:** accepted
**Date:** 2026-05-04

## Context

We need a JavaScript runtime for a CLI/TUI tool that reads JSONL session logs, embeds SQLite, and ships fast cold-start (matters for `npx`).

## Decision

Use **Bun** with TypeScript strict mode.

## Rationale

- Fast cold-start — meaningful for `npx @plouto/boost` users running it occasionally.
- Native `bun:sqlite` avoids the `better-sqlite3` native build pain.
- Matches OpenCode's runtime choice; later integrations (v0.2+) easier.
- TypeScript-native execution, no separate compile step in dev.

## Consequences

- Distribution is `bun build` to a bundled `dist/cli.js` runnable on Node ≥ 20 where the surface allows, but the CLI assumes Bun in dev. Production runtime guarantee: Bun ≥ 1.1.
- Tests use `bun:test`, not `vitest`.
