# Releasing

Checklist for cutting a `boost` release.

## Pre-flight

- [ ] All tests pass on CI on macOS and Linux
- [ ] `bun run typecheck` clean
- [ ] `bun run build` produces a working bundle
- [ ] CHANGELOG.md updated; "Unreleased" moved to a dated heading
- [ ] Version bumped in `package.json` matches the upcoming git tag
- [ ] README's Quick Start works on a fresh terminal
- [ ] `npm pack --dry-run` lists the right files (no fixtures, no test output)
- [ ] No HTTP client added to `package.json` since the last release

## Cut

1. Commit the version bump and CHANGELOG.
2. Tag: `git tag vX.Y.Z` and `git push --tags`.
3. The GitHub Actions release workflow runs `bun test`, `bun run build`, and `npm publish --provenance`.

## Post-publish

- [ ] `npx @plouto/boost` works from a fresh shell on a fresh machine
- [ ] `npm view @plouto/boost` shows the new version
- [ ] Provenance attestation appears on the published package page
- [ ] Watch issues for first-day breakage
