---
name: boost
description: Local optimization loop for Claude Code — dispatcher. Routes to the right skill from the boost-skills companion plugin.
arguments:
  - name: action
    description: "(none) = audit · apply <id> · apply-all · trim-claude-md · reskill · reskill <name> = draft-project-skill · revert [id] · yield"
    required: false
---

Parse `$ARGUMENTS` into `action` (first word) and `rest` (everything after).

The actual operational logic for each action lives as a skill in the companion **`boost-skills`** plugin (distributed via the [PloutoAI/skills](https://github.com/PloutoAI/skills) marketplace). This slash command exists for muscle-memory invocation; the skills also auto-activate on natural language and are user-invocable directly via `/boost-skills:<name>`.

Dispatch:

| `action` value | Skill to follow |
|---|---|
| (empty), `check`, `audit` | **`boost-skills:audit`** — show current findings |
| `apply claude-md-bloat` | **`boost-skills:trim-claude-md`** — LLM-driven trim of CLAUDE.md |
| `apply <id>`, `apply-all`, `apply --all` | **`boost-skills:apply`** — pass-through to `boost apply` |
| `trim-claude-md` (explicit) | **`boost-skills:trim-claude-md`** |
| `reskill` (no second word) | **`boost-skills:reskill`** — list opportunities |
| `reskill <name>` | **`boost-skills:draft-project-skill`** — author a SKILL.md draft |
| `revert`, `revert <op-id>` | **`boost-skills:revert`** |
| `yield` | **`boost-skills:yield`** — outcome attribution |
| anything else | list recognised actions; suggest the closest match |

Read the matched skill's `SKILL.md` and follow its instructions exactly. The skill files are the single source of truth.

**If `boost-skills` isn't installed**, the skill files won't be in your context. In that case, tell the user:

```
/plugin install PloutoAI/skills
```

then enable `boost-skills`, and reload. (Without those skills, the slash command still works for the trivial pass-through actions — but trim-claude-md and draft-project-skill require the skill content.)

The `boost` binary at `${CLAUDE_PLUGIN_ROOT}/bin/boost.mjs` is the underlying engine each skill shells out to. Offline-only, no network, state under `~/.boost/`.
