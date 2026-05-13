---
name: boost
description: Local optimization loop for Claude Code — dispatcher. Routes to the right skill based on the action.
arguments:
  - name: action
    description: "(none) = audit · apply <id> · apply-all · trim-claude-md · reskill · reskill <name> = draft-project-skill · revert [id] · yield"
    required: false
---

Parse `$ARGUMENTS` into `action` (first word) and `rest` (everything after).

Each action's actual logic lives in a sibling skill at `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md`. Skills auto-activate on natural language matching their description AND are user-invocable directly via `/boost:<name>`. This slash command exists for muscle-memory dispatch.

| `action` value | Skill to follow |
|---|---|
| (empty), `check`, `audit` | **audit** — show current findings |
| `apply claude-md-bloat` | **trim-claude-md** — LLM-driven trim of CLAUDE.md (bypasses the dumb stash-and-stub) |
| `apply <id>`, `apply-all`, `apply --all` | **apply** — straight pass-through to `boost apply` |
| `trim-claude-md` (explicit) | **trim-claude-md** |
| `reskill` (no second word) | **reskill** — list opportunities |
| `reskill <name>` | **draft-project-skill** — author a SKILL.md draft from observed activity |
| `revert`, `revert <op-id>` | **revert** |
| `yield` | **yield** — outcome attribution |
| anything else | list recognised actions; suggest the closest match |

Read the matched skill's `SKILL.md` and follow its instructions exactly. The skill files are the single source of truth — do not duplicate the logic inline.

The `boost` binary at `${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs` is the underlying engine each skill shells out to. Offline-only, no network, state under `~/.boost/`.
