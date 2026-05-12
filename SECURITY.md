# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in `boost`, **please do not open a public GitHub issue.**

Email `security@plouto.dev` with:

- A description of the issue
- Steps to reproduce, or a proof-of-concept
- Affected version (`boost --version`)

We will acknowledge receipt within **72 hours**. After triage, we will share a timeline for remediation.

## Scope

In scope:

- Bypasses of the path-safety checks (`backup`, `apply`, `revert` paths escaping allowed roots)
- Symlink-following bugs in backup or restore
- Backup-tampering issues that cause `revert` to silently restore wrong contents
- Prototype-pollution from parsing `settings.json`
- Resource-exhaustion bugs in the JSONL parser

Out of scope:

- Issues that require a compromised user account or local filesystem write access (we are not a security boundary against actors with the user's privileges — see [threat model §C4](docs/internals/threat-model.md#c4-out-of-scope))
- TUI rendering bugs that don't affect data integrity
- Vulnerabilities in upstream dependencies (please report those upstream; we'll bump versions on disclosure)

## Threat model

The full threat model is documented at [docs/internals/threat-model.md](docs/internals/threat-model.md). New features that add attack surface must update it before merging.
