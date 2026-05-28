# ADR 003: Device-code auth over localhost-redirect

**Status:** accepted
**Date:** 2026-05-22
**Supersedes:** the localhost-redirect flow first shipped in `src/plouto/oauth.ts`

## Context

`boost install` needs to get a Plouto bearer token onto the engineer's
machine without making them copy-paste it out of a settings page. Two
browser-based patterns are standard:

1. **Localhost-redirect** (`gh auth login`, `gcloud auth login`, `fly
   auth login`): the CLI opens an ephemeral local HTTP server, sends the
   browser to `…/cli/login?port=P&state=S`, and waits for the platform to
   redirect back to `http://localhost:P/callback?token=…`.
2. **Device-code** (RFC 8628; `gh` on headless boxes, `aws sso login`,
   `stripe login`): the CLI shows a short `user_code`, the user approves
   it in any browser, and the CLI polls until the platform marks the code
   approved.

We shipped (1) first (`oauth.ts`). It broke in the most common pilot
setup.

## Decision

Use the device-code flow (`src/plouto/device-auth.ts`) as the default
and only browser auth path. Remove the localhost-redirect implementation.

## Rationale

- **Remote dev boxes are the norm, not the exception.** Pilots run Claude
  Code over SSH on a cloud VM or devcontainer. The localhost-redirect
  flow assumes the browser that opens can reach `http://localhost:P` on
  the *same* machine the CLI runs on — false over SSH. Device-code has no
  loopback dependency: the code is approved from whatever browser the
  engineer has, anywhere.
- **No inbound port.** The CLI never opens a listening socket, so there's
  nothing for a local firewall, corporate proxy, or container network
  policy to block, and no port-in-use race.
- **Cleaner URL.** The user sees `team.plouto.ai/device` + a 6–8 char
  code, not `…?port=53217&state=8f3a…`.
- **Industry has moved this way.** `gh` falls back to device-code on any
  headless/SSH context; `aws sso`, `stripe`, and `vercel` lead with it.

## Consequences

- `src/plouto/oauth.ts` (131 lines, the localhost-redirect server,
  success/error HTML, state verification) is deleted. It had no callers
  after `install.ts` switched to `runDeviceAuth`.
- The CLI takes on a poll loop + expiry countdown instead of a blocking
  server accept. Slightly more client code, but no socket lifecycle to
  manage.
- Tradeoff accepted: device-code is marginally more steps for the user
  (read code → approve) vs. a pure redirect. Worth it to work over SSH,
  which is where the pilots actually are.
