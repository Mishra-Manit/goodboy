# Inspiration Notes

## What Is This?

**background coding orchestration system** that continuously pulls work from Linear, runs it through a configurable AI pipeline, and publishes/updates GitHub PRs with minimal human intervention.

---

## End-to-End Capability Map (What It Does)

### 1) Intake + Dispatch
- Polls Linear on a fixed interval (default 30s).
- Filters by assignee and active states.
- Applies concurrency limits (global + per-state).
- Prevents immediate redispatch loops with barriers.
- Reconciles running work against external changes (unassignment, terminal state, etc.) and cancels when needed.

### 2) Triage (optional, LLM-powered)
- Chooses workflow (or defaults to label-based routing).
- Picks base/target branches.
- Picks merge strategy (`pr_only` vs `auto_merge`).
- Can request clarification and pause dispatch.
- Has deterministic fallback behavior if triage fails.

### 3) Workspace Lifecycle
- Creates per-issue isolated workspace.
- Runs lifecycle hooks (`after_create`, `before_run`, optional cleanup hooks).
- Resets repository cleanly between attempts.
- Persists internal state for checkpoints/threads.
- Syncs skill docs into the workspace for agents.

### 4) Pipeline Execution Engine
- Executes DOT-defined directed graphs.
- Supports node types:
  - `agent` (LLM-backed stage)
  - `tool` (shell/tool command stage)
  - `fan_out` / `fan_in` patterns (parallel variants)
- Uses label-driven routing (`lgtm`, `revise`, `escalate`).
- Captures stage artifacts + structured stage results.
- Maintains thread continuity across revision loops.

### 5) Safety + Reliability
- Stage visit limits (`max_visits`) with exhaustion routes.
- Global per-run invocation budget.
- Retry with exponential backoff for transient failures.
- Error classification for auth/rate-limit failures.
- Checkpointing and resumability after restart.
- Escalation path to human review state.

### 6) GitHub Automation
- Creates PRs (`publish-pr`) from generated title/body artifacts.
- Updates existing PRs for revision loop (`update-pr`).
- Stores PR metadata in workspace state.
- Can enable GitHub auto-merge (without bypassing branch protection).

### 7) Revision Loop from Webhooks
- Receives GitHub webhooks for reviews/comments.
- Triggers revision workflow on “changes requested” or command.
- Fetches and compiles review feedback context.
- Relabels/requeues issue and updates same PR in-place.

### 8) Notifications + Human Visibility
- Slack notifications for success/failure/escalation/credential issues.
- Optional user mapping from Linear user IDs to Slack mentions.
- Dedupes repeated failure notifications.

### 9) API + Control Plane
- REST API with auth (`API_KEY`).
- Endpoints for state, run history/details, stage details, config CRUD, workflow preview, skills/agents/backends management.
- SSE events stream for real-time status.

### 10) Dashboard
- Live monitor with KPIs, run list, run detail views.
- Real-time updates via SSE.
- Editors for workflows (builder + raw DOT), agents, skills.
- Config views for execution, triage, GitHub, Slack, fan-out, routing.

---

## Built-In Workflows (Shipped)

### A) `default.dot` (main coding workflow)
`start -> plan -> review_plan -> code -> review_code -> fix_code loop -> prepare_pr -> publish_pr -> exit`

- Plan and code each have review gates.
- `revise` loops back, `escalate` exits to human review.
- Includes visit limits and thread continuity.

### B) `revision.dot` (post-review patch workflow)
`start -> revise -> update_pr -> publish_pr_update -> exit`

- Consumes PR review feedback.
- Updates existing PR instead of creating a new one.

### C) `document.dot`
`start -> write_docs -> review_docs -> exit`

- Documentation drafting and review workflow.

### D) `knowledge.dot`
`start -> write_knowledge -> review_knowledge -> prepare_pr -> publish_pr -> exit`

- Knowledge/article generation workflow with PR publication.

---

## Config Architecture (Copy This)

Everything is declared in `WORKFLOW.md`:
- tracker (Linear)
- polling
- workspace + hooks
- execution limits
- escalation rules
- triage
- backends (CLI command templates)
- agents (prompt/model/backend bindings)
- workflows (DOT graphs)
- workflow routing by label
- GitHub + Slack integrations

This is the strongest reusable pattern: **behavior as config + graph**, not hardcoded logic.

---

## Key Design Takeaways for Building Your Own Internal Coding Agent

1. Use a **workflow engine** as the product core.
2. Keep model calls small and role-specific (planner, reviewer, fixer, PR-preparer).
3. Make routing deterministic; use LLM outputs only as controlled labels.
4. Enforce safety limits at multiple levels.
5. Preserve execution artifacts for debugging and trust.
6. Separate orchestration from channel input (Linear today, Telegram tomorrow).
7. Provide operational APIs + dashboard from day one.

---

## Important Source Files (for deeper study)

- Orchestrator startup: `orchestrator/src/index.ts`
- API server: `orchestrator/src/api/server.ts`
- Linear tracker client: `orchestrator/src/tracker.ts`
- Workflow docs: `docs/workflows.md`, `docs/how-it-works.md`, `docs/configuration.md`
- Workflow definitions: `pipelines/default.dot`, `pipelines/revision.dot`, `pipelines/document.dot`, `pipelines/knowledge.dot`
- Dashboard views: `dashboard/src/app/sdad/*`
