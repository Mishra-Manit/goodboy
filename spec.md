# Goodboy -- Background Coding Agent System

## Overview

Goodboy is a background coding system controlled via Telegram. You send it a task, it explores the codebase, asks clarifying questions, plans, implements, reviews, and opens a PR -- all autonomously. A dashboard provides real-time visibility into everything the system is doing.

The intelligence lives entirely inside [pi](https://github.com/mariozechner/pi-coding-agent) instances. Goodboy is thin glue: a Telegram bot, a task queue, a pi process manager, a webhook receiver, and a dashboard API -- nothing more.

---

## System Flow

```
You (Telegram)
  |
  v
Orchestrator receives message, validates user, resolves repo
  |
  v
Creates git worktree for the task
  |
  v
Stage 1: Planner (pi RPC instance)
  - Explores codebase
  - Asks clarifying questions via Telegram (bridged through orchestrator)
  - You reply, orchestrator pipes answers back into the same pi process
  - Simple tasks: auto-proceeds. Complex tasks: waits for /go confirmation
  - Writes plan.md and exits
  |
  v
Stage 2: Implementer (pi RPC instance)
  - Reads plan.md
  - Writes code, commits to worktree branch
  - Writes implementation-summary.md and exits
  |
  v
Stage 3: Reviewer (pi RPC instance)
  - Reads plan.md, implementation-summary.md, and the diff
  - Reviews code and fixes any issues itself
  - Iterates until satisfied
  - Writes review.md and exits
  |
  v
Stage 4: PR Creator (pi RPC instance)
  - Pushes branch to remote
  - Creates GitHub PR via gh CLI
  - Notifies you on Telegram: "PR is up"
  |
  v
GitHub webhook fires on PR comments/reviews
  - Orchestrator spawns a Revision pi instance
  - Reads PR feedback, makes fixes on the same branch, pushes
  - Cycle repeats for each round of review comments
```

---

## Architecture

### Single Process

One Node.js/TypeScript process handles everything:
- Telegram bot (Grammy)
- Task queue and pi process management
- REST API + SSE for the dashboard (Hono)
- GitHub webhook receiver
- Static file server for the dashboard build

### Pi Integration

Pi is spawned in **RPC mode** (`pi --mode rpc`) as a subprocess per stage. RPC mode provides:
- JSON protocol over stdin/stdout
- Persistent process -- send prompts, read events, send follow-ups without restarting
- Structured events: `agent_start`, `agent_end`, `message_update`, `tool_execution_*`
- Steering and follow-up message queuing

**Intra-stage communication**: RPC. The Planner asks a question, orchestrator reads the `agent_end` event, sends it to Telegram, waits for your reply, pipes it back as a new `prompt` command to the same pi process.

**Inter-stage communication**: File-based. Each stage writes its output to a known file in the goodboy filesystem. The next stage's pi instance is told to read that file. This gives clean separation and a full audit trail.

**Stage completion signaling**: Each pi instance's system prompt enforces a structured JSON marker at the end of its output:
- `{"status": "needs_input", "questions": [...]}` -- orchestrator bridges to Telegram
- `{"status": "complete"}` -- orchestrator advances to next stage

### Concurrency

- Configurable parallel task cap (default: 2)
- Each task runs in its own git worktree for full isolation
- Worktrees are created at task start, cleaned up after PR merge/completion

### Multi-Repo

- Config-based repo registry: explicit name-to-path mapping
- User always specifies the target repo in their Telegram message
- Orchestrator validates the repo name against the registry before proceeding

---

## Monorepo Structure

```
goodboy/
  src/
    bot/              # Grammy Telegram bot, message handling, conversation state
    orchestrator/     # Task queue, pi process lifecycle, stage sequencing
    api/              # Hono REST endpoints + SSE for dashboard
    webhooks/         # GitHub webhook handler (PR comments/reviews)
    db/               # Drizzle schema, migrations, queries (Postgres on Neon)
    shared/           # Types, constants, config loading
  dashboard/          # Vite + React + Tailwind + shadcn/ui (static export)
  artifacts/          # Runtime: per-task handoff files (plan.md, review.md, etc.)
  package.json
  tsconfig.json
  drizzle.config.ts
  spec.md
```

---

## Telegram Bot

### Library
Grammy

### Auth
Restricted to a single Telegram user ID (env var). All other messages are ignored.

### Commands
- `/repos` -- list registered repos
- `/status` -- show active tasks and their current stage
- `/cancel <task_id>` -- kill a running task
- `/retry <task_id>` -- retry a failed task
- `/go` -- confirm a plan and kick off implementation

### Conversation Model
1. User sends a task message (must include repo name)
2. Orchestrator creates a task, spawns Planner pi instance
3. If Planner has questions: orchestrator sends them to the Telegram chat
4. User replies naturally -- orchestrator pipes the reply back into the Planner's RPC session
5. Planner outputs structured marker when ready:
   - Simple tasks: `{"status": "complete"}` immediately, no confirmation needed
   - Complex tasks: `{"status": "ready", "summary": "..."}` -- orchestrator sends summary to Telegram and waits for `/go`
6. After confirmation (or auto-proceed), pipeline advances through remaining stages

### Notifications
Telegram notifications at every major state transition:
- Plan ready for confirmation
- Implementation complete, PR created (with link)
- PR review comment received, revision started
- Revision pushed
- Task failed (with error details)

---

## Pi Instances (Stages)

Each stage is a separate pi process spawned via `pi --mode rpc`. Each has its own:
- System prompt defining its role and output format
- Skills and tools relevant to the stage
- Model configuration (can vary per stage)

### Stage 1: Planner
- **Input**: Task description from Telegram + repo path
- **Behavior**: Explores the codebase (reads files, greps, understands structure). Asks clarifying questions if needed. Produces a comprehensive plan.
- **Output**: `artifacts/<task_id>/plan.md` -- full context dump + step-by-step implementation plan
- **RPC**: Kept alive for conversation. Orchestrator bridges Telegram replies into the session.

### Stage 2: Implementer
- **Input**: `plan.md`
- **Behavior**: Follows the plan. Writes code, creates/edits files, commits to the worktree branch.
- **Output**: `artifacts/<task_id>/implementation-summary.md` -- what was done, files changed, decisions made

### Stage 3: Reviewer
- **Input**: `plan.md` + `implementation-summary.md` + git diff
- **Behavior**: Reviews the implementation against the plan. Finds issues and fixes them itself. Iterates until satisfied.
- **Output**: `artifacts/<task_id>/review.md` -- review notes, issues found, fixes applied

### Stage 4: PR Creator
- **Input**: `review.md` + branch name + repo info
- **Behavior**: Pushes the branch to remote. Runs `gh pr create` with an appropriate title and body derived from the plan and implementation.
- **Output**: PR URL (stored in DB, sent to Telegram)

### Revision Stage (triggered by webhook)
- **Input**: PR feedback (comments/review) + existing branch
- **Behavior**: Reads the feedback, makes fixes on the same branch, pushes.
- **Output**: Updated PR

---

## Dashboard

### Stack
- Vite + React
- Tailwind CSS + shadcn/ui
- Static export served by Hono from the orchestrator process

### Auth
API key in request header. Key set via env var.

### Real-Time Updates
SSE (Server-Sent Events) from the Hono API. Events for:
- Task state transitions
- Stage progress
- Live log output from pi instances
- PR status changes

### Views

**Active Tasks**
- Currently running tasks with repo, stage, progress
- Live streaming logs from the running pi instance

**Task History**
- Completed and failed tasks
- Filterable by repo, status, date
- Expandable to show all artifacts (plan, summary, review)

**Task Detail**
- Full timeline of a single task
- All handoff artifacts rendered (plan.md, implementation-summary.md, review.md)
- Logs per stage
- PR link and status

**Repo Registry**
- List of registered repos with paths
- (Future: add/remove from dashboard)

**PR Status**
- Open PRs created by the system
- Review state, comment count
- Link to revision runs if any

---

## API

### Base
Hono server, same process as the orchestrator. All endpoints require `X-API-Key` header.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks (filterable by status, repo) |
| GET | `/api/tasks/:id` | Task detail with artifacts and stage history |
| GET | `/api/tasks/:id/logs` | Logs for a specific task |
| GET | `/api/tasks/:id/artifacts/:name` | Raw artifact file (plan.md, etc.) |
| POST | `/api/tasks/:id/retry` | Retry a failed task |
| POST | `/api/tasks/:id/cancel` | Cancel a running task |
| GET | `/api/repos` | List registered repos |
| GET | `/api/prs` | List PRs created by the system |
| GET | `/api/events` | SSE stream for real-time updates |

---

## Database

### Provider
Postgres on Neon (serverless)

### ORM
Drizzle

### Schema (core tables)

**tasks**
- `id` (uuid, pk)
- `repo` (text) -- repo name from registry
- `description` (text) -- original Telegram message
- `status` (enum: queued, planning, implementing, reviewing, creating_pr, revision, complete, failed, cancelled)
- `current_stage` (text, nullable)
- `branch` (text, nullable)
- `worktree_path` (text, nullable)
- `pr_url` (text, nullable)
- `pr_number` (int, nullable)
- `error` (text, nullable)
- `created_at` (timestamp)
- `updated_at` (timestamp)
- `completed_at` (timestamp, nullable)

**task_stages**
- `id` (uuid, pk)
- `task_id` (uuid, fk -> tasks)
- `stage` (text) -- planner, implementer, reviewer, pr_creator, revision
- `status` (enum: running, complete, failed)
- `started_at` (timestamp)
- `completed_at` (timestamp, nullable)
- `pi_session_id` (text, nullable)
- `error` (text, nullable)

**repos**
- `name` (text, pk)
- `local_path` (text)
- `github_url` (text, nullable)
- `created_at` (timestamp)

---

## GitHub Webhooks

### Events
- `pull_request_review` -- triggers revision when "changes requested"
- `pull_request_review_comment` / `issue_comment` -- triggers revision on new comments

### Flow
1. Webhook fires, orchestrator receives it
2. Matches PR to a task via `pr_number` in DB
3. Fetches review feedback context
4. Creates a new worktree (or reuses existing)
5. Spawns a Revision pi instance with the feedback
6. Pi fixes issues, pushes to same branch
7. PR updates automatically
8. Notifies you on Telegram

### Webhook endpoint
`POST /webhooks/github` -- validated with webhook secret

---

## Deployment

### Infrastructure
- EC2 instance (already provisioned)
- pm2 for process management and auto-restart
- Postgres on Neon (managed)

### Process
Single pm2 process running the compiled TypeScript orchestrator.

### Secrets (env vars in pm2 ecosystem config)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_USER_ID`
- `DATABASE_URL` (Neon connection string)
- `GITHUB_WEBHOOK_SECRET`
- `API_KEY` (dashboard auth)
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` (inherited by pi)
- `GH_TOKEN` (for gh CLI, inherited by pi)

### Domain / Access
- EC2 public IP or domain for dashboard + webhook endpoint
- HTTPS via Caddy or similar reverse proxy (needed for GitHub webhooks)

---

## Tech Stack Summary

| Component | Choice |
|-----------|--------|
| Language | TypeScript |
| Telegram bot | Grammy |
| API server | Hono |
| Frontend | Vite + React |
| Styling | Tailwind + shadcn/ui |
| Database | Postgres (Neon) |
| ORM | Drizzle |
| AI execution | Pi coding agent (RPC mode) |
| PR creation | gh CLI |
| Process manager | pm2 |
| Real-time | SSE |

---

## Out of Scope (for now)
- Multiple users / team support
- Linear or other issue tracker integration
- Auto-merge (PRs require manual merge)
- Containerization / Docker
- CI/CD pipeline for goodboy itself
- Custom workflow graphs / DOT pipelines (fixed 4-stage pipeline)
- Dashboard-based repo management (config file only)
