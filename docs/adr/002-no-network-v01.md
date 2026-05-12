# ADR 002: No network calls in v0.1

**Status:** accepted
**Date:** 2026-05-04

## Context

The category includes tools that ship dollar-converted reports, fetch pricing data, and post anonymous telemetry. Each adds privacy review burden and offline-fragility.

## Decision

v0.1 has zero outbound network calls. No telemetry, no pricing fetch, no analytics.

## Rationale

- Privacy claim is enforced by code, not policy. Audit is simple: any HTTP client in `package.json` is a regression.
- Removes a whole class of failure modes (offline, proxy, captive portals).
- Reports use percentages, not dollars — sidesteps the pricing-data question entirely.

## Consequences

- `--show-cost` deferred to v0.2 with bundled pricing snapshot.
- Future telemetry/sync features reopen the threat model. See `threat-model.md` §C6.
