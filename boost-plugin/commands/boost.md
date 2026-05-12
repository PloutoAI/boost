---
name: boost
description: Local optimization loop for Claude Code — dispatcher. Routes to the right skill based on the action.
arguments:
  - name: action
    description: "(none) = audit · apply <id> · apply-all · trim-claude-md · reskill · reskill <name> = draft-project-skill · revert [id] · yield"
    required: false
---

Parse `$ARGUMENTS` into `action` (first word) and `rest` (everything after).

Dispatch to the matching skill below. The skill carries the actual instructions; this slash command exists for explicit invocation (`/boost:boost <action>`). Users can also invoke each skill directly via its own slash command (`/boost:audit`, `/boost:trim-claude-md`, etc.) or just say what they want — the skills' descriptions auto-activate them on natural language.

| `action` value | Skill to follow |
|---|---|
| (empty), `check`, `audit` | **audit** — show current findings |
| `apply claude-md-bloat` | **trim-claude-md** — LLM-driven trim of CLAUDE.md (the dumb stash-and-stub bypass) |
| `apply <id>`, `apply <id> ...`, `apply-all`, `apply --all` | **apply** — straight pass-through to `boost apply` |
| `trim-claude-md` (explicit) | **trim-claude-md** |
| `reskill` (no second word) | **reskill** — list opportunities |
| `reskill <name>` | **draft-project-skill** — author a SKILL.md draft from observed activity |
| `revert`, `revert <op-id>` | **revert** |
| `yield` | **yield** — outcome attribution |
| anything else | tell the user the recognised actions; suggest the closest match |

For the matched skill, read its `SKILL.md` (located at `${CLAUDE_PLUGIN_ROOT}/skills/<skill-name>/SKILL.md`) and follow its instructions exactly. The skill files are the single source of truth for each action's behaviour — do not duplicate the logic inline.

The `boost` binary at `${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs` is the underlying engine each skill shells out to. It's offline-only; no network, no telemetry. State lives under `~/.boost/`.
