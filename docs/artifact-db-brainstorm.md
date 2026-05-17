# Artifact + Transcript Database Brainstorm

## Goal

Persist the useful, durable information currently trapped in `artifacts/<taskId>/` into Postgres, while keeping heavyweight/local-only files on disk.

Explicitly keep local:

- `artifacts/memory-*` repo memory folders.
- Raw agent JSONL transcripts.
- Large binary review assets such as PNG screenshots.
- Large diffs unless a specific downstream feature needs them indexed.

Move into DB:

- Declared canonical agent outputs for coding/question flows: `plan.md`, `implementation-summary.md`, `review.md`, and `answer.md`. PR review display artifacts stay local for now.
- Transcript summaries: session identity, path, model/cost/token aggregates, tool count, and duration.

Do not build a general filesystem inventory. If an artifact is not an explicit output contract or system-declared product artifact, it stays local.

## Current model evaluation

### What works well

The current DB model is clean for lifecycle state:

- `tasks` owns user-visible work: repo, kind, description, status, branch/PR metadata, error, timestamps.
- `task_stages` owns pipeline progress: stage, variant, status, timestamps, error.
- `pr_sessions` and `pr_session_runs` track PR follow-up lifecycle separately from the original task.
- `memory_runs` is already a good precedent for making one operational subsystem first-class without stuffing everything into `tasks`.

The filesystem model is also simple:

- Task files are deterministic under `artifacts/<taskId>/`.
- Session JSONL paths are deterministic per stage: `<stage>[.vN].session/<stage>[.vN].session.jsonl`.
- Output contracts already centralize many expected file paths, labels, schemas, and dashboard metadata.

### What is breaking down

The database does not know what artifacts exist. The dashboard has to derive and read files from disk:

- `/api/tasks/:id/session` reads JSONL files on demand from deterministic paths.
- `/api/tasks/:id/artifacts/:name` reads a single root-level filename from disk.
- Nested artifacts like `reports/*.json` and subagent artifacts are not generally addressable through the artifact route.
- `task_stages.piSessionId` exists, but session path/id/metrics are not consistently persisted.
- If local artifacts are deleted or the app moves hosts, the DB task history survives but the useful details disappear.
- There is no cheap query for questions like:
  - “Show me all plans for repo X.”
  - “Which stages used the most tokens?”
  - “Which artifact files are missing from disk?”

### Is the current model the right base?

Yes for lifecycle. No for artifact intelligence.

The best direction is additive: keep `tasks`, `task_stages`, `pr_sessions`, `pr_session_runs`, and `memory_runs` as lifecycle owners, then add artifact/session tables that reference them. Do not overload `tasks` with columns like `planText`, `reviewText`, `tokenCount`, etc. That would couple the schema to today’s pipeline outputs and make PR review variants/subagents awkward.

## Proposed model

### Core idea

Use contract-backed artifact records plus specialized transcript/session summaries.

- `task_artifacts` answers: “Which declared product artifact file did this task produce, and what canonical content does Postgres own?”
- `agent_sessions` answers: “What pi/agent run produced this, where is its raw transcript, and what did it cost?”

Do not add a per-turn transcript table. Raw JSONL already holds the detailed replay locally, and a turn table would create a second, partial transcript model that is expensive to keep accurate. The product should persist session-level summaries and metrics, then fall back to local JSONL only when a human wants the full replay.

### Table sketch

#### `task_artifacts`

One row per declared product artifact contract for a task. This table is not a filesystem index.

Suggested fields:

- `id uuid primary key`
- `task_id uuid not null references tasks(id)`
- `task_stage_id uuid references task_stages(id)` nullable
- `producer_session_id uuid references agent_sessions(id)` nullable
- `file_path text not null` — path relative to `artifacts/<taskId>/`, e.g. `plan.md`
- `content_text text` nullable — canonical content for markdown/plain-text artifacts
- `content_json jsonb` nullable — canonical content for JSON artifacts
- `sha256 text not null` — content fingerprint used to detect DB/local drift
- `created_at timestamp not null default now()`
- `updated_at timestamp not null default now()`

Rules:

- Exactly one of `content_text` or `content_json` is populated.
- The artifact writer validates `file_path` against the declared outputs for the task/stage before writing. Invalid files are rejected, not persisted as failed rows.
- Volatile PR context/diff files do not get rows here unless they become declared product artifacts later.

Indexes/constraints:

- Unique artifact file: `(task_id, file_path)`.
- Query by stage/session: `(task_stage_id)`, `(producer_session_id)`.
- Instance/dev/prod scope derives from the parent `tasks` row, matching how `task_stages` works.

#### `agent_sessions`

One row per raw pi JSONL session that Goodboy cares about. This is a lightweight transcript pointer plus the few summary fields useful for dashboard/debugging.

Suggested fields:

- `id uuid primary key`
- `task_stage_id uuid references task_stages(id)` nullable
- `pr_session_run_id uuid references pr_session_runs(id)` nullable
- `memory_run_id uuid references memory_runs(id)` nullable
- `agent_name text not null` — `planner`, `implementer`, `reviewer`, `pr_analyst`, etc.
- `pi_session_id text not null` — header id from JSONL
- `session_path text not null` — raw local JSONL path
- `model text`
- `duration_ms integer`
- `total_tokens integer`
- `cost_usd numeric`
- `tool_call_count integer`

Rules:

- Instance/dev/prod scope derives from the owning `task_stages`, `pr_session_runs`, or `memory_runs` row.
- Exactly one owner path is present: `task_stage_id`, `pr_session_run_id`, or `memory_run_id`.
- This table tracks parent/top-level agent sessions. Subagent work is tracked as child rows in `subagent_runs`.
- Raw JSONL stays local at `session_path`; this table does not copy turns/messages.
- Session failure/cancellation detail is read from the owning lifecycle row and raw logs, not duplicated here. `duration_ms` is stored because it is a compact, useful performance metric without duplicating lifecycle timestamps.

Indexes/constraints:

- Unique `pi_session_id`.
- Query by owner: `(task_stage_id)`, `(pr_session_run_id)`, `(memory_run_id)`.

#### `subagent_runs`

One row per delegated subagent task that Goodboy wants to show or analyze. These rows are children of the parent agent session that made the delegation call.

Suggested fields:

- `id uuid primary key`
- `parent_agent_session_id uuid references agent_sessions(id) not null`
- `agent_name text not null`
- `run_index integer` nullable
- `prompt text not null` — the task sent to the subagent
- `result_text text` nullable — raw final subagent output exactly as returned
- `status text not null` — `running`, `complete`, `failed`
- `model text` nullable
- `duration_ms integer` nullable
- `total_tokens integer` nullable
- `cost_usd numeric` nullable
- `tool_call_count integer` nullable

Rules:

- No `task_id`; scope derives through `parent_agent_session_id`.
- No input/output/meta artifact foreign keys unless those become canonical product artifacts. Most subagent files are scratch implementation details.
- No `run_key`; `id` and `(parent_agent_session_id, run_index)` are enough.
- Track the same compact performance metrics as parent sessions so subagent fanout cost and tool usage are visible.

Indexes/constraints:

- `(parent_agent_session_id, run_index)` for stable ordering.

## Write path design

### Canonical artifact writer tool

Canonical agent outputs should move from “agent writes an arbitrary path” to “agent calls a Goodboy artifact tool.” The tool owns validation, DB writes, and local materialization.

Example calls:

```json
{
  "artifactKey": "coding.plan",
  "content": "# Plan..."
}
```

```json
{
  "artifactKey": "prReview.report",
  "params": { "reportId": "group-01" },
  "content": { "subagent_id": "group-01", "issues": [] }
}
```

Tool behavior:

1. Validate `filePath` against the declared outputs allowed for the current task/stage. The agent cannot write arbitrary product artifacts.
2. Validate text/JSON against the declared contract for that file.
3. Upsert `task_artifacts` with content, producer session/stage, and hash.
4. Write the same content to the local artifact path so later stages can still read files as context.
5. Return the materialized path and DB artifact id to the agent.

This keeps file-based agent handoff intact while making the DB the durable record for canonical outputs.

### Sync points

1. During each stage, agents call the artifact writer tool for declared canonical outputs.
2. After each `runStage` completes:
   - Verify every required contract has a valid `task_artifacts` row and matching local materialized file.
   - Parse the session JSONL once and upsert `agent_sessions` summary.
3. System-prewritten volatile context files stay local:
   - PR context/diff files.
   - Updated PR context/diff refreshes.
   - Reviewer feedback snapshots if treated as input context.
4. Do not run a broad artifact inventory scan. Only declared product artifacts enter `task_artifacts`; raw JSONL is summarized through `agent_sessions`.

### Content ownership rules

Canonical agent outputs are DB-recorded and local-materialized by the artifact writer tool. Volatile context remains local-first.

Recommended thresholds:

- Canonical markdown/text: store `content_text` and materialize local file.
- Canonical JSON: parse/store `content_json` and materialize pretty JSON locally.
- PR context/diff files: local-only because they refresh as commits change.
- Images/binaries: local-only plus local serving route.
- JSONL: local-only plus `agent_sessions` summary rows.

### Source of truth

The DB should become the source of truth for small canonical artifacts. The disk copy is a materialized handoff/cache for later agents, prompts, and local debugging.

For volatile PR context, diffs, raw transcripts, and images, disk remains source of truth. DB stores session summaries, not local-file catalog rows.

## API/dashboard impact

Likely new or changed routes:

- `GET /api/tasks/:id/artifacts` — list artifact rows from DB.
- `GET /api/tasks/:id/artifacts/:artifactId` — serve DB content or local file by artifact id.
- Keep legacy `/api/tasks/:id/artifacts/:name` during migration.
- `GET /api/tasks/:id/session-summary` — DB-backed agent session summaries.
- Keep current `/api/tasks/:id/session` for raw/full transcript display while local file exists.

Dashboard changes:

- Artifact panel should render DB-listed artifacts instead of hardcoded `TASK_KIND_CONFIG.artifacts` only.
- Transcript tab can load summary fast from DB, with a “raw transcript” path for detailed local replay.
- PR review page continues reading local PR review artifacts for now.

## Migration strategy

1. Add tables only. No behavior changes.
2. Add a targeted backfill script:
   - match existing tasks;
   - read only known declared artifact paths for each task kind;
   - upsert `task_artifacts` for those declared outputs;
   - parse raw JSONL only to upsert `agent_sessions` summaries.
3. Wire new writes after stage completion.
4. Switch dashboard artifact list to DB-backed route with disk fallback.

## Risks and tradeoffs

- **DB bloat:** controlled by storing only declared canonical outputs and session summaries.
- **Sensitive data:** artifact text may include secrets. Need sanitization or an explicit allowlist per artifact contract before DB persistence.
- **Double source of truth:** small canonical artifacts in DB plus disk copies can drift. Store `sha256` and prefer DB for reads once persisted.
- **Schema over-generalization:** avoid a huge event-store for every JSONL line. Use summaries, not raw replay.
- **Migration complexity:** route fallback lets us roll this out incrementally.

## Recommendation

Build the product model around four durable concepts:

1. `task_artifacts` for declared coding/question product outputs only.
2. `agent_sessions` aggregate summaries from raw JSONL.
3. `subagent_runs` for visible delegated work and raw subagent results.
Dashboard artifact reads should prefer DB content for declared outputs, with disk fallback only for local-only context/raw files. This captures durable product data without treating Postgres like blob storage or inventing a second transcript format.
