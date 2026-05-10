# Goodboy Internals

A technical walkthrough of the non-obvious mechanisms in the backend. Read this to understand how the system actually works under the hood.

---

## 1. Agent Output Contracts

The contract system solves a fundamental problem: when you spawn an AI agent as a subprocess, how do you guarantee it produced the right outputs and in the right format?

### The Contract Definition Layer

Every pipeline declares its expected outputs in an `output-contracts.ts` file using two builder functions:

- `defineTextOutput()` — the file must exist and be non-empty
- `defineJsonOutput()` — the file must exist, parse as JSON, and satisfy a Zod schema

Each contract captures four concerns in one object:

```ts
defineTextOutput({
  id: "coding.plan",                          // unique identifier for errors/logs
  path: () => "plan.md",                      // relative path inside artifacts dir
  prompt: { name: "implementation plan", instructions: "..." },  // injected into agent prompt
  dashboard: () => ({ key: "plan.md", label: "plan" }),          // how the dashboard shows it
})
```

The `resolve(rootDir, params)` method turns a contract into a `ResolvedFileOutputContract` with an absolute filesystem path. This is what validation actually checks against.

### How It Connects to Prompts

`shared/agent-output/prompts.ts` has two functions that render contracts into prompt text:

- `outputContractPromptBlock(contracts)` — tells the agent exactly what files to write, their paths, format requirements, and policies (required/optional/softRequired)
- `finalResponsePromptBlock(contract)` — tells the agent its last message must be bare JSON like `{"status":"complete"}`

So when you write a pipeline stage, you declare the contract once, and the prompt instructions, validation rules, and dashboard metadata all derive from it. No manual synchronization needed.

### Validation at Stage Exit

When `runStage` completes (pi subprocess exits cleanly):

1. **Final response check** — reads the session JSONL, finds the last assistant message, and verifies it's exactly `{"status":"complete"}` (or a richer schema like `{"status":"complete","prUrl":"..."}` for PR creator)
2. **File output validation** — `validateFileOutputs()` iterates each declared contract, checks the file exists and is non-empty, and for JSON contracts additionally parses + Zod-validates the content
3. **postValidate hook** — optional per-stage custom validation that runs after file checks pass (used by PR creator to extract the PR URL from the final response)

The policy system (`required` / `optional` / `softRequired`) controls whether a missing file is a hard failure or a warning. `softRequired` means "log it but don't kill the stage."

### The PR Review Pipeline's Contracts (Complex Example)

`pr-review/output-contracts.ts` shows the system at scale — parameterized contracts where `path` and `dashboard` are functions of `{ reportId }` or `{ variant }`. The `report` contract uses `prReviewReportSchema` which validates the exact JSON shape of each analyst slice, including an enum restriction on `dimensions` values (`"correctness" | "style" | "tests" | "security"` — nothing else). The prompt even includes a `DIMENSIONS_LEGEND` and a copyable `skeleton` so the agent has a concrete example of valid output.

---

## 2. Worktree Lifecycle

Goodboy never touches the main checkout directly for task work. Every task gets its own git worktree — an independent working directory sharing the same `.git` object store.

### Creation Flow

1. **`syncRepo(repoPath)`** — fetches origin and hard-resets main so new branches start from the latest code
2. **`generateBranchName(taskId, description)`** — calls Fireworks with a Zod-validated schema to produce a 2-6 word kebab-case slug, retries up to 3 times, then builds `goodboy/<slug>-<taskId[:8]>`
3. **`createWorktree(repoPath, branch, taskId)`** — force-removes any existing worktree/branch with that name (for retries), then `git worktree add -b <branch> <dir>`
4. **`stageSubagentAssets(dir)`** — copies `pi-assets/` into `<worktree>/.pi/` so the pi subprocess can discover project-scoped agents (like `codebase-explorer`)
5. **`hideAgentsFileInWorktree()`** — reads the repo's `AGENTS.md`, stores its content as an advisory string, then `git update-index --skip-worktree` + deletes the file from disk so the agent can't accidentally follow it as binding instructions

The worktree path follows the pattern: `<repo-parent>/goodboy-worktree-<taskId[:8]>` (or `goodboy-pr-<id[:8]>` for PR review/session worktrees).

### PR Worktrees

PR review and PR session worktrees are different — they check out the PR's actual head branch (not a new branch). The tricky part: if that branch is already checked out in a stale coding worktree from the original task, git refuses to fetch into it. So `createPrWorktree` first scans all worktrees via `git worktree list --porcelain`, finds any that have the target branch checked out, force-removes them, then fetches and creates.

### Cleanup

Three entry points in `core/cleanup.ts`:

- **`dismissTask()`** — full teardown: closes the GitHub PR (`gh pr close --delete-branch`), removes worktree, deletes local branch, marks task cancelled
- **`cleanupTaskResources()`** — disk-only: removes worktree + branch but keeps PR metadata for history
- **`cleanupPrSession()`** — removes worktree + branch + the pi session JSONL directory

All of them go through `removeWorktree()` which has a fallback path: if `git worktree remove --force` fails (stale metadata), it `rm -rf`s the directory and runs `git worktree prune`.

### Artifacts Directory

Separate from worktrees. Lives at `artifacts/<taskId>/` and holds the outputs that stages produce (plan.md, implementation-summary.md, review.md, JSON reports, etc.). Created fresh at pipeline start via `prepareArtifactsDir()` which wipes any existing dir. Cleaned up by a daily TTL sweep (`artifacts-cleanup.ts`) — anything UUID-shaped older than 7 days gets deleted. Memory directories (`memory-*`) are excluded from the sweep because they have their own lifecycle.

---

## 3. Pi RPC and Session Logging

### How Pi Gets Spawned

`core/pi/spawn.ts` runs `pi --mode rpc --session <path> --no-extensions --no-skills --system-prompt "..." --model "..."`. The `--mode rpc` flag makes pi communicate over stdin/stdout as JSONL instead of a terminal UI.

The spawned process:
- Receives prompts via stdin: `{"type":"prompt","message":"..."}`
- Emits events on stdout: `{"type":"agent_end"}`, `{"type":"extension_ui_request",...}`, `{"type":"response",...}`
- Writes its own session file to `--session <path>` as JSONL (this is pi's native format, not ours)

### The Session File as Source of Truth

Pi writes every conversation turn (system, user, assistant messages + tool calls/results) into the session JSONL file. Goodboy never writes to this file — it only reads/tails it.

The session file path: `artifacts/<taskId>/<stage>.session/<stage>.session.jsonl`

It's nested in its own directory because pi-subagents (when enabled for the planner) write their own session files as siblings in that directory.

### Tailing for Live Dashboard Updates

`session-file.ts#watchSessionFile()` is a hybrid poll + fs.watch tail:

1. Polls every 500ms checking if the file exists yet (pi creates it lazily after first output)
2. Once found, attaches `fs.watch` for low-latency change detection
3. On each change: opens the file, reads from the last known offset, splits into lines, parses each as JSON
4. Handles partial lines across chunk boundaries (stores leftover in a `partial` buffer)
5. Handles file truncation (if `size < offset`, resets to 0)

Each parsed entry is passed to `broadcastSessionFile()` which wraps it in an SSE event and calls `emit()` from the events system.

### The Events Pub/Sub

`shared/runtime/events.ts` is an in-process pub/sub. It's just a `Set<Listener>` with `subscribe()` and `emit()`. The SSE endpoint in the API subscribes one listener per connected dashboard client. When a session entry arrives, it gets broadcast to every open SSE connection in real-time.

Event types include: `task_update`, `stage_update`, `session_entry` (the live log stream), and others.

### Extension UI Auto-Confirm

When pi hits an extension that needs user input (confirm/select/input dialogs), it emits `extension_ui_request`. Since goodboy runs unattended, `spawn.ts` auto-responds: confirms for `confirm` prompts, cancels for everything else. This prevents the subprocess from hanging forever waiting for human input that will never come.

### Final Response Extraction

After `waitForCompletion()` resolves (pi emits `agent_end` or the process exits), `runStage` reads the session file, finds the last assistant message, and validates it against the stage's final response contract. This is how goodboy knows the agent actually finished its work vs. crashed mid-thought.

---

## 4. Dashboard Hosting

The dashboard is a Vite React SPA that gets served by the same Hono server as the API. No separate frontend server in production.

### Build

`npm run build` runs both `tsc` (backend) and `vite build` (dashboard). The Vite build outputs to `dashboard/dist/`.

### Serving Strategy

In `src/index.ts`:

```ts
app.route("/", api);                              // API routes first (REST + SSE)
app.use("/*", serveStatic({ root: "./dashboard/dist" }));  // Static assets
app.get("/assets/*", (c) => c.text("Not found", 404));     // Hashed assets → 404 if missing
app.get("*", async (c) => c.html(await readFile("./dashboard/dist/index.html", "utf-8")));  // SPA fallback
```

The SPA fallback reads `index.html` at request time (not cached in memory) so that during `vite build --watch` in dev mode, new builds with different hashed asset paths are served immediately without restarting the server.

The `/assets/*` 404 guard prevents the SPA fallback from accidentally serving `index.html` as a JS or CSS file when a hashed asset is missing (which would cause cryptic parse errors in the browser).

### Dev Mode

`npm run dev` runs both `tsx watch` (backend with live reload) and `vite build --watch` (dashboard rebuild on change) in parallel. The dashboard talks to the same-origin API via relative URLs, no proxy needed.

---

## 5. Memory System

Each registered repo gets a persistent knowledge base at `artifacts/memory-<INSTANCE_ID>-<repo>/`.

### Structure

```
memory-dev-goodboy/
  .state.json          # version, lastIndexedSha, zones list
  .lock                # atomic contention lock (taskId + pid + timestamp)
  _root/               # overview.md, architecture.md, patterns.md, map.md, glossary.md
  frontend/            # zone: overview.md, map.md
  backend/             # zone: overview.md, map.md
  checkout/            # dedicated git worktree for the memory agent's cwd
```

### Concurrency Control

Memory runs use a skip-on-contention lock (not a queue). `tryAcquireLock` uses `fs.writeFile` with `flag: "wx"` (exclusive create) — if the file already exists, it means another run is active and this one skips. Stale locks (older than 10 minutes or dead PID) are auto-recovered.

The `withMemoryRun()` wrapper owns the full lifecycle: acquire lock → ensure worktree → run body → reset worktree → release lock. If the task gets cancelled mid-run, `cancelTask()` removes the lock file directly as a safety net.

### Memory Worktree

Separate from per-task worktrees. Pinned to `origin/main`, hard-reset before every run, and `git clean -fdx` after. The memory agent sees a pristine checkout and is not allowed to modify it (enforced by prompt + post-run `git status --porcelain` check).

---

## 6. Other Notable Patterns

### Subagent Assets Staging

The `pi-assets/` directory at repo root contains agent definitions (like `codebase-explorer.md`). These get copied into `<worktree>/.pi/` before any stage runs so that pi-subagents can discover them as project-scoped agents. Only the planner stage actually loads the pi-subagents extension; other stages run `--no-extensions` for reproducibility.

### AGENTS.md Hiding

The user's `AGENTS.md` in the repo is deliberately hidden from the agent via `git update-index --skip-worktree` + file deletion. Its content is passed as an advisory prompt section instead — the agent sees it as context but can't accidentally treat it as binding instructions or try to restore/edit it.

### Model Resolution

`resolveModel("PI_MODEL_PLANNER")` checks for a stage-specific env var first, falls back to `PI_MODEL` (the global default). This lets you run cheap models for simple stages and expensive ones for planning/implementation without changing code.

### Branch Name Generation via LLM

`generateBranchName()` uses `structuredOutput()` (Fireworks API + Zod schema) to turn a task description into a clean kebab-case slug. The schema enforces `^[a-z0-9]+(-[a-z0-9]+){1,5}$` — 2-6 lowercase words. Temperature starts at 0, bumps to 0.5 on retry. Final branch: `goodboy/<slug>-<taskId[:8]>`.

### The Logger

No `console.log` anywhere in app code. Every file uses `createLogger("module-name")` which produces colored, timestamped output: `[2024-01-15T12:00:00Z] [INFO] [stage] Starting stage planner for task abc12345`. Levels: debug/info/warn/error. Warn and error go to stderr; debug and info go to stdout.

### Startup Recovery

On boot, `src/index.ts` runs several recovery passes:
1. `pruneWorktrees()` on all registered repos (cleans stale git metadata)
2. `cleanupStaleMemoryLocks()` (removes locks from previous crashes)
3. `reapRunningRows()` (marks orphaned DB rows as failed so the dashboard doesn't show them as eternally running)
4. `findOrphanedMemoryDirs()` (warns about memory dirs for repos no longer in config)

### Artifact TTL Sweep

A daily interval (`startArtifactsSweep()`) scans `artifacts/` for UUID-shaped directories older than 7 days and deletes them. This prevents disk from growing unbounded. Memory dirs are excluded (they're not UUID-shaped).

### Task Cancellation

Cancellation is cooperative: `cancelTask()` adds the taskId to a `cancelledTasks` Set, kills any active pi session, and releases memory locks. Every stage checks `isTaskCancelled()` before starting. The flag persists until `resetTaskCancellation()` is called (by a retry). The pi subprocess kill triggers `TaskCancelledError` which propagates up through all wrappers so their `finally` blocks run cleanup.

### Pipeline Common Shell

`pipelines/common.ts#withTaskPipeline()` standardizes the boilerplate: load task from DB, resolve repo config, reset cancellation, wrap in an observability span. `prepareTaskPipeline()` goes further: notify Telegram, prepare artifacts dir, sync repo, run the memory stage, check cancellation. Every pipeline calls these instead of reimplementing the 6-step setup.
