# `src/strategies/` — detectors and fixes

One file per strategy. Each file exports a default `StrategyDefinition` (see `../strategy.ts`).

Adding a new strategy: copy an existing one, change ID/version, write `detect`, write a test in `tests/strategies/`, append to the registry in `index.ts`. The full guide is at [`docs/writing-a-strategy.md`](../../docs/writing-a-strategy.md).

The registry is alphabetical. Adding a strategy is intentionally a registry edit — we want PRs that add detectors to be visibly listed.
