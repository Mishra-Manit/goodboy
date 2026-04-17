# pi-assets

Assets consumed by pi subprocesses spawned inside task worktrees: subagents,
skills, prompt templates, rules.

At worktree creation, the contents of this directory are copied recursively
into `<worktree>/.pi/`. Any existing `.pi/` in the target repo is silently
overwritten for the duration of the worktree's lifetime.

The destination is `.pi/` (not `.pi/agent/`) because pi-subagents discovers
project-scoped agents at `<cwd>/.pi/agents/` via its
`findNearestProjectAgentsDir` helper.

## Layout

```
pi-assets/
  agent/             → <worktree>/.pi/agent/             (pi core agent dir -- models.json, etc)
    models.json
  agents/            → <worktree>/.pi/agents/            (pi-subagents project scope)
  skills/            → <worktree>/.pi/skills/            (reserved)
  prompt-templates/  → <worktree>/.pi/prompt-templates/  (reserved)
  rules/             → <worktree>/.pi/rules/             (reserved)
```

Two dirs look similar but serve different tools:
- `.pi/agent/` is pi core's user config directory (models.json, auth.json, etc).
  Goodboy points stage pi processes at this via `PI_CODING_AGENT_DIR`.
- `.pi/agents/` is where pi-subagents discovers project-scoped agent
  definitions. Required path, set by pi-subagents.

## Current assets

### `agent/models.json`

Pins custom Fireworks-hosted models for pi's model registry:
- `accounts/fireworks/models/llama-v3p3-70b-instruct` — used by the
  codebase-explorer subagent for fast read-only exploration.
- `accounts/fireworks/models/kimi-k2p5` — available for main pipeline
  stages (planner/implementer/reviewer) via `PI_MODEL_*` env vars.

Api key is resolved from the `FIREWORKS_API_KEY` environment variable at
request time, so no secrets are committed. Every stage in the pipeline sets
`PI_CODING_AGENT_DIR=<worktree>/.pi/agent` so stage and subagent pi processes
all read this file instead of the host's `~/.pi/agent/models.json`.

### `agents/codebase-explorer.md`

Read-only Llama 3.3 70B subagent invoked by the planner for parallel
codebase research. Returns a rigid `## Finding / ## Evidence / ## Caveats`
markdown block per query.

## Conventions

- Agent definitions explicitly set `extensions:` (empty value) and
  `inheritSkills: false` / `inheritProjectContext: false` to prevent user
  extensions and skills from leaking into subagent processes.
- Keep subagent system prompts focused, with rigid output formats where the
  parent stage needs to splice findings into its own artifacts.
