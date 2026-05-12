# Contributing to boost

Thanks for considering a contribution. boost is a young project; the goal is for it to remain trustworthy and small.

## Dev setup

```sh
bun install
bun test
bun run typecheck
bun run build
```

`bun run boost` runs the CLI from source.

## Project structure

Every directory under `src/` containing more than one file has a `README.md`. Start there.

- `src/data/` — JSONL ingestion + static config readers
- `src/strategies/` — detectors (one file per strategy)
- `src/apply/` — backup, apply, revert
- `src/output/` — JSON, check, plain ANSI
- `src/output/tui/` — Ink TUI components

## Proposing a new strategy

Read [docs/writing-a-strategy.md](docs/writing-a-strategy.md). Open an issue describing the rule before writing code; we want to agree on the criteria before implementation.

## Code style

- TypeScript strict mode is enforced (`tsc --strict`). No separate linter in v0.1.
- TSDoc on every exported symbol.
- Module-level `README.md` for any `src/` directory with more than one file.
- Errors are user-facing. Every error answers: what happened, why, what should the user do?

## Sharp edges

Read [docs/internals/sharp-edges.md](docs/internals/sharp-edges.md) before working on anything marked risky.

## Threat model

Every change that touches files, paths, or backups must satisfy the constraints in [docs/internals/threat-model.md](docs/internals/threat-model.md).

## Commits and PRs

- Conventional Commits (`feat:`, `fix:`, `docs:`, etc.)
- Open an issue first for non-trivial changes
- PRs include tests and a CHANGELOG entry
- Breaking changes (in 0.x) need an ADR in `docs/adr/`

## License

By contributing, you agree your contributions are licensed under MIT.
