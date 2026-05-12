# `src/output/` — non-TUI output modes

`json.ts` is the structured-output contract used by `boost --json`. It's the canonical shape future web UIs and scripts read; document any change in `docs/json-schema.md`.

`check.ts` implements `boost --check`: a compact one-screen finding summary with non-zero exit on medium-or-higher findings.

`plain.ts` implements the non-TTY fallback used when stdout isn't a terminal (piped, redirected, `TERM=dumb`).
