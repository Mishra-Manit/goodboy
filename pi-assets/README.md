# pi-assets

Assets consumed by pi subprocesses spawned inside task worktrees: subagents,
skills, prompt templates, rules.

At worktree creation, the contents of this directory are copied recursively
into `<worktree>/.pi/agent/`. Any existing `.pi/agent/` in the target repo is
silently overwritten for the duration of the worktree's lifetime.

## Layout

```
pi-assets/
  agents/            → <worktree>/.pi/agent/agents/
  skills/            → <worktree>/.pi/agent/skills/            (reserved)
  prompt-templates/  → <worktree>/.pi/agent/prompt-templates/  (reserved)
  rules/             → <worktree>/.pi/agent/rules/             (reserved)
```

## Current assets

- `agents/codebase-explorer.md` — read-only exploration subagent invoked by
  the planner stage for parallel codebase research. Uses a small open-source
  model (Llama 3.3 70B on Fireworks) and returns a rigid
  `## Finding / ## Evidence / ## Caveats` markdown block per query.

## Conventions

- Agent definitions explicitly set `extensions:` (empty value) and
  `inheritSkills: false` / `inheritProjectContext: false` to prevent user
  extensions and skills from leaking into subagent processes.
- Keep subagent system prompts focused, with rigid output formats where the
  parent stage needs to splice findings into its own artifacts.
