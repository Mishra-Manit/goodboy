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
  agents/            → <worktree>/.pi/agents/            (pi-subagents project scope)
```

## Current assets

### `agents/codebase-explorer.md`

Read-only Kimi K2.5 subagent invoked by the planner and PR analyst for parallel
codebase research. Returns `## Finding / ## Evidence / ## Caveats` by default,
but obeys explicit JSON-only schemas for PR-review report artifacts.

## Model registry

Kimi K2.5 (via Fireworks) is the only model goodboy uses, wired in through
the host's `~/.pi/agent/models.json` on both the laptop and the EC2 host.
Stage pi processes inherit that file naturally — no project-local override,
no `PI_CODING_AGENT_DIR` env var. If you spin up a fresh machine, add the
Fireworks provider there before running a task.

## Conventions

- Agent definitions explicitly set `extensions:` (empty value) and
  `inheritSkills: false` / `inheritProjectContext: false` when supported to
  prevent user extensions and skills from leaking into subagent processes.
- Keep subagent system prompts focused, with rigid output formats where the
  parent stage needs to splice findings into its own artifacts.
