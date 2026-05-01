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

Read-only codebase research subagent invoked by the planner and memory pipeline.
Returns `## Finding / ## Evidence / ## Caveats` by default, but obeys explicit
JSON-only schemas when asked.

### `agents/pr-slice-reviewer.md`

Fast read-only PR review subagent invoked by the PR analyst. It reads one group
from `review-plan.json`, anchors issues to changed lines in `pr.diff`, and
returns compact JSON only. It uses the same MiniMax M2.7 model as the general
codebase explorer so PR review fanout stays cheap and predictable.

## Model registry

Goodboy stage models are selected through `PI_MODEL*` env vars and resolved
against the host's `~/.pi/agent/models.json` on both the laptop and the EC2
host. Fireworks models currently used here include MiniMax M2.7.
Stage pi processes inherit that registry naturally — no project-local override,
no `PI_CODING_AGENT_DIR` env var. If you spin up a fresh machine, add the
Fireworks provider entries there before running a task.

## Conventions

- Agent definitions explicitly set `extensions:` (empty value) and
  `inheritSkills: false` / `inheritProjectContext: false` when supported to
  prevent user extensions and skills from leaking into subagent processes.
- Keep subagent system prompts focused, with rigid output formats where the
  parent stage needs to splice findings into its own artifacts.
