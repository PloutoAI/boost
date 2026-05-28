# Threat Model

This is the security spec. The build must satisfy it. Update it before any feature that adds attack surface.

## C1. What boost does, security-relevantly

boost is a CLI that:

- Reads `~/.claude/projects/**/*.jsonl` (Claude Code session logs, can be large and contain user prompts)
- Reads static config files (`~/.claude/settings.json`, CLAUDE.md, skill directories, plugin directories)
- Writes to its own data home (`~/.boost/`) — SQLite database, backups, operations log
- Modifies user-owned files in `~/.claude/` when the user approves a fix

It does **not**:

- Make any network calls (in v0.1)
- Execute arbitrary code from config files
- Run commands on the user's behalf
- Touch files outside `$HOME` or its declared roots
- Collect, transmit, or persist data beyond the local machine

## C2. Trust Boundaries

### What boost trusts

- **The user's filesystem** under specific allowed roots: `$BOOST_HOME` (default `~/.boost/`), `$CLAUDE_CONFIG_DIR` (default `~/.claude/`), and the project working directory if scoped to it
- **The bundled strategies** (TS modules in `src/strategies/`) — version-pinned with the package, reviewed in PR
- **The `~/.boost/db.sqlite` file** as long as integrity checks pass on open. SQLite's `PRAGMA integrity_check` runs at startup; failure refuses to start
- **Standard system utilities** (`fs.realpath`, `crypto.randomUUID`, `crypto.createHash`, `bun:sqlite`)

### What boost does NOT trust

- **JSONL file contents.** Produced by Claude Code based partly on user prompts and tool outputs. May contain attacker-influenced data via prompt injection. Treat every field as untrusted input.
- **`settings.json` contents.** User may have hand-edited into invalid state. Other tools may have modified. Structured but untrusted.
- **Filesystem paths inside config files.** Paths in CLAUDE.md `@import`, paths in plugin definitions, paths in MCP server configs — may point outside expected locations or be symlinks. Canonicalize and validate before any access.
- **The mtime of files we're about to modify.** Another process may modify between our last read and our write. Re-check mtime at apply time.
- **External code.** boost has no plugin/extension loading in v0.1. No `require()` of user-supplied paths, no `eval`, no shell execution.

## C3. Specific Threats and Mitigations

### C3.1 Symlink attack on backup or restore

**Scenario:** an attacker (or accidental misconfiguration) places a symlink at a path boost is about to back up. If boost follows the symlink during backup, it could end up reading a sensitive file (`/etc/passwd`, an SSH key) and storing its contents in `~/.boost/backups/`. During restore, following a symlink could overwrite a file outside the intended target.

**Mitigation:**
- Backup operations use `lstat` to detect symlinks before opening; refuse to back up if a symlink is detected
- Restore operations refuse to write through symlinks. Destination checked with `lstat` immediately before write; `safeRoot` is passed so `refuseSymlinkInAncestors` walks every intermediate dir (and now `safeRoot` itself) before the rename — closes the asymmetry where the forward path had ancestor protection but the reverse did not
- File copy uses `O_NOFOLLOW`-equivalent semantics (Bun's fs primitives respect this)

**Known open gap (tracked):** `assertWithinAllowedRoots()` and `pickSafeRoot()` both call `fs.realpathSync` for canonicalization, which silently follows symlinks. An attacker who swaps an ancestor between bootstrap and the moment canonicalization runs ends up with both ends agreeing on the *resolved* path — and the ancestor checks then pass. Closing this requires switching canonicalization to lexical + per-component `lstat`. Defense-in-depth on the eventual write boundary still applies, but the trust chain is weaker than the prose above implies until that work lands.

**Tests:** symlink fixtures in `tests/fixtures/symlinks/`. Each backup-kind test runs against a symlinked target and verifies refusal with a clear error.

### C3.2 Path traversal in fix payloads

**Scenario:** a malformed strategy or malicious fix payload specifies a `filePath` like `~/.claude/../../../../tmp/evil`. Without validation, boost would write to `/tmp/evil`.

**Mitigation:**
- Every path in a `Fix` payload is canonicalized via `realpath` before any operation
- After canonicalization, the path must be within an allowed root: `$BOOST_HOME`, `$CLAUDE_CONFIG_DIR`, or the current project's working directory
- Any path failing the root check aborts with a path-safety error

**Tests:** `tests/security/path-traversal.test.ts` covers evasion attempts: `..` traversal, Unicode tricks, symlinks pointing outside roots, paths starting with `/`, paths starting with `\\`.

### C3.3 JSONL parser DoS via huge lines

**Scenario:** a JSONL file contains a single line many gigabytes long (corrupt write or crafted file). A naive parser allocates memory proportional to line length and runs out.

**Mitigation:**
- Per-line max: 1 MB. Lines exceeding skip with warning logged.
- Total file scan cap: 500 MB. Beyond, parsing stops with warning.
- Streaming parser uses bounded buffer; never loads full file into memory.

**Tests:** synthetic 100MB and 1GB files, with mixed line sizes including some over the per-line limit.

### C3.4 Settings.json with prototype pollution

**Scenario:** `settings.json` contains `{"__proto__": {"polluted": true}}`. A naive merge into a JS object would pollute `Object.prototype`.

**Mitigation:**
- Use `jsonc-parser` which doesn't perform merging
- Code reading from parsed object uses property access rather than spread/Object.assign on user-controlled data
- Reviewer checks for Object.assign / spread on parsed user data in PR review

**Tests:** fixture with prototype-pollution payload; test that `Object.prototype.polluted` is undefined after boost runs.

### C3.5 Race condition during apply

**Scenario:** the user runs boost in one terminal. Detection completes. Before the user approves and apply runs, the user (or another process) modifies the target file in another terminal. boost's apply now writes based on stale assumptions.

**Mitigation:**
- Before applying any fix, re-stat the target file and compare mtime + size to what was observed during detection
- If changed, abort with: "the file has changed since boost scanned it; please rerun boost and try again."
- Operation record stores the observed-at-detection mtime; any mismatch aborts cleanly without writing

**Tests:** simulated mtime change between detection and apply produces clean abort.

### C3.6 Database corruption or tampering

**Scenario:** `~/.boost/db.sqlite` is corrupted (filesystem error, partial write during crash) or tampered with.

**Mitigation:**
- On open, run `PRAGMA integrity_check`. If it fails, refuse to start, point user at recovery docs
- WAL journaling mode for safer concurrent reads / crash recovery
- Operations table records SHA-256 of pre and post state. Tampering with a backup file is detected on revert (hash mismatch)
- Integrity of operations table itself is *not* defended against an attacker with write access to the DB. Documented as out-of-scope (see C4)

**Tests:** fixture with deliberately-corrupted DB; boost refuses to start with clear message.

### C3.7 Operations log forgery

**Scenario:** an attacker modifies the operations table to claim an apply happened when it didn't, hiding their own changes from the user.

**Mitigation:**
- Partially defended by SHA-256 integrity hashes: recorded `beforeHash` should match the file at apply time. If an attacker modifies the file outside boost without updating the hash, the next revert attempt fails the hash check
- Full defense against an attacker with arbitrary filesystem write access is out of scope

### C3.8 Backup tampering

**Scenario:** an attacker modifies a `.bak` file to make a future revert restore the wrong contents.

**Mitigation:**
- Each Operation row records `beforeHash` (SHA-256 of pre-modification state)
- During revert, after loading the backup, boost computes its hash and compares to `beforeHash`. Mismatch refuses revert with: "backup tampered or corrupted; refusing to restore."
- Catches tampering in the backup file but does not defend against simultaneous tampering of the DB row

### C3.9 Argument injection / shell metacharacter handling

**Scenario:** a path or strategy ID containing shell metacharacters (`;`, `|`, `$()`, etc.) is interpolated into a command somewhere.

**Mitigation:**
- boost never invokes a shell. All filesystem operations go through `bun:fs` primitives, not `child_process.exec`
- The only subprocess we might invoke (none in v0.1) would use `spawn` with array-style arguments, never `exec` with a string
- Reviewers check for `exec`, `execSync`, backticks, or shell strings in PR review

### C3.10 Resource exhaustion via many small JSONL files

**Scenario:** `~/.claude/projects/` contains thousands of small JSONL files (corrupt state, accidental).

**Mitigation:**
- File discovery has a sanity cap (10,000 files). Beyond this, log warning and process the most recently-modified subset
- Per-file processing is incremental; we don't hold all parsed events in memory at once

### C3.11 Permissions on `~/.boost/`

**Scenario:** another user on the same multi-user machine reads boost's data.

**Mitigation:**
- `~/.boost/` is created with mode 0700
- `~/.boost/identity.json` is mode 0600
- Backups are mode 0600
- We don't enforce or repair permissions on existing files (avoid surprising the user); we set them on creation only

## C4. Out of Scope

boost is not designed to defend against, and explicitly does not claim to defend against:

- **A compromised user account.** If an attacker has the user's credentials or filesystem write access, no application-layer defense is sufficient. boost is a tool to help the user, not a security boundary against malicious actors with the user's privileges.
- **Side-channel attacks** via filesystem timing, cache contention, etc.
- **Compromise of dependencies.** We pin versions and run `bun audit`, but a sufficiently advanced supply-chain attack on a transitive dependency is outside our defense.
- **Network-level attacks.** boost has no network in v0.1. When network features are added in future versions, this section will be updated.
- **Information disclosure to other processes on the same machine.** Standard Unix permissions apply; we don't add encryption-at-rest for `~/.boost/`.
- **A malicious local strategy.** v0.1 only ships built-in, version-pinned strategies. When dynamic strategy loading is added in v0.2+, this section will need significant expansion.

## C5. Privacy Commitments

These are user-facing promises, enforced by code:

- **No data leaves the machine in v0.1.** boost has no network code, no telemetry shipping, no analytics. The presence of `node-fetch`, `axios`, or any HTTP client in `package.json` is a regression and must be reviewed.
- **No third-party services contacted.** Even for things like LiteLLM pricing data — bundled with the package, not fetched.
- **No prompt content is read for analysis.** We extract structural metadata (token counts, tool names, model selection) from JSONL. We do not parse, analyze, or store prompt or completion text.
- **No code content is read for analysis.** File paths from Claude Code are read for tracking purposes; file contents (project source code) are never read.
- **The `--debug` flag** may include file paths and structured metadata in its output. It does not include prompt content, completion content, or file contents. Users should still be careful about sharing debug output publicly.

## C6. Acceptance Criteria for New Features

Any future feature that adds attack surface must update Part C before merging:

- New network code → add a section covering the network threat model
- Dynamic strategy loading → add sections on strategy sandboxing, supply chain, and signing
- Cloud sync → add sections on data-in-transit, server-side trust, key management
- Multi-user features → expand Out of Scope to clarify what's defended in shared environments

This isn't bureaucracy — it's the discipline that keeps boost trustworthy as it grows.

## C7. Enforcement layer — the networked write path (0.2.x)

0.2.0 added Plouto's enforcement tier: a SessionStart hook runs `boost
plouto-sync`, which `GET`s `/api/plugin/strategies`, applies each action
to the engineer's local config, and `POST`s receipts back. This is a
**new trust boundary the original C1–C5 prose predates** — C5's "no
network" guarantee holds for the local optimization path (Tier 1) but
NOT for the enforcement path (Tier 2).

### What the enforcement path trusts

- **The bearer token + `apiUrl`** from `PLOUTO_TOKEN` / `~/.plouto/config.json`.
- **TLS** to `team.plouto.ai` (or the configured `apiUrl`).

### What it does NOT trust

- **`StrategyAction` field contents from the server.** The server may be
  compromised, MITM'd despite TLS, or driven by a malicious/curious
  workspace admin (admins author strategies). Every field that becomes a
  filesystem path or a file's contents is untrusted input.

### C7.1 Path traversal via `target` (fixed)

**Scenario:** a strategy returns `target = "../../../tmp/x"`. Joined onto
`~/.claude/skills/<target>`, `removeSkill` would `rm -rf` an arbitrary
path; `installSkill` would write outside the config tree — arbitrary
file delete/write on every engineer's machine from one bad policy.

**Mitigation:** `assertSafeSegment()` rejects any `target` that isn't a
single path segment (no `/`, `\`, control chars, `.`/`..`, absolute
paths, or anything where `basename(t) !== t`). The resolved directory is
re-checked with `assertWithinAllowedRoots([claudeHome()])` as
defense-in-depth. Model-recommend validates the model id and refuses to
write outside `$HOME`. **Tests:** `tests/plouto/enforce.test.ts`.

### C7.2 No local revert trail for enforced changes (known gap)

The enforcement path writes with raw `fs` calls, **not** through the
`apply/` substrate — so enforced skill installs / model recommendations
have no SHA-256 backup and are **not** undoable via `boost revert`. A bad
policy push can't be rolled back locally; the engineer's only recourse is
the server retracting it. Tracked: route enforcement writes through the
backup/revert pipeline so the networked path gets the same reversibility
the local path has. Until then, enforced kinds are deliberately limited
to ones with contained blast radius (placeholder SKILL.md, project-scoped
`settings.local.json:model`). As enforcement grows to push real skill
payloads, MCP config, and CLAUDE.md, each new kind must land with both
the C7.1 input validation AND the C7.2 revert trail.

### C7.3 Token at rest

`PLOUTO_TOKEN` lives in `~/.claude/settings.json:env` or
`~/.plouto/config.json`. Standard Unix perms apply; we don't add
encryption-at-rest (consistent with C3.11). A token leak lets an attacker
*read* the workspace's strategy list and *forge* apply-receipts — it does
not grant write access to other engineers' machines.
