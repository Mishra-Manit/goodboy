# Goodboy Architecture Guide

A comprehensive walkthrough of the Goodboy codebase -- architecture, engineering decisions, patterns, and how everything connects.

> **Pattern rules live in `AGENTS.md` -> Code Patterns.** This doc explains
> *how* the system works; `AGENTS.md` is the contract every new file must
> follow. When the two disagree, `AGENTS.md` wins.

---

## Table of Contents

1. [What Is Goodboy?](#what-is-goodboy)
2. [The Two-Build-Pipeline Architecture](#the-two-build-pipeline-architecture)
3. [The Entry Point](#the-entry-point)
4. [Config and the Lazy Singleton Pattern](#config-and-the-lazy-singleton-pattern)
5. [Type System -- Const Arrays as Source of Truth](#type-system----const-arrays-as-source-of-truth)
6. [Event Bus -- Pub/Sub for SSE](#event-bus----pubsub-for-sse)
7. [Database Layer](#database-layer)
8. [Telegram Bot](#telegram-bot)
9. [Hono and the HTTP Server](#hono-and-the-http-server)
10. [REST API Routes](#rest-api-routes)
11. [Server-Sent Events (SSE)](#server-sent-events-sse)
12. [The Pipeline -- Core Orchestration](#the-pipeline----core-orchestration)
13. [Pi RPC -- Process Management](#pi-rpc----process-management)
14. [Git Worktrees](#git-worktrees)
15. [Prompt Engineering](#prompt-engineering)
16. [Dashboard Architecture](#dashboard-architecture)
17. [How the Frontend Connects to the Backend](#how-the-frontend-connects-to-the-backend)
18. [The One-Server Trick](#the-one-server-trick)
19. [Patterns Worth Internalizing](#patterns-worth-internalizing)

---

## What Is Goodboy?

Goodboy is a **background coding agent** controlled via Telegram. You send it a task like `goodboy add dark mode toggle`, it spins up an AI pipeline (Plan > Implement > Review > PR), and opens a GitHub PR autonomously. A React dashboard gives you real-time visibility into what the agent is doing.

Think of it as your own self-hosted Devin-lite.

---

## The Two-Build-Pipeline Architecture

One repo, one `node_modules`, but two completely separate build pipelines:

| Build | Tool | Entry | Output | Config |
|-------|------|-------|--------|--------|
| Backend | `tsc` (TypeScript compiler) | `src/` | `dist/` | Root `tsconfig.json` |
| Dashboard | `vite` | `dashboard/src/` | `dashboard/dist/` | `dashboard/tsconfig.json` + `dashboard/vite.config.ts` |

How this works:

- The backend tsconfig has `"outDir": "dist"` and `"rootDir": "src"` -- it compiles TS to JS files that Node runs directly.
- The dashboard tsconfig has `"noEmit": true` -- Vite handles all bundling/transpilation, the TS compiler only does type checking.
- The root tsconfig `"exclude": ["dashboard"]` means backend compilation completely ignores the frontend code.
- `"module": "ESNext"` + `"moduleResolution": "bundler"` -- this is the modern ESM setup. No CommonJS.

**Why this structure?** Keeping them in the same repo means shared `node_modules` (no monorepo tooling overhead), but separate tsconfigs means each build has the right settings for its runtime (Node vs browser).

---

## The Entry Point

**File:** `src/index.ts`

```
dotenv/config import (side-effect: loads .env)
         |
    loadEnv() -- Zod validation
         |
    +----------+
    |  Hono    |  Grammy Bot
    |  Server  |  (Telegram)
    +----------+
         |
    Shutdown hooks (SIGINT/SIGTERM)
```

Key patterns:

### Side-Effect Imports

```typescript
import "dotenv/config";
```

This is a side-effect import. It mutates `process.env` before anything else runs. This is the standard way to load `.env` files in Node. The import has no exported value -- it just executes code.

### Zod Validation at Startup

```typescript
const env = loadEnv();
```

Instead of trusting `process.env` blindly, every env var is validated at startup. If `DATABASE_URL` isn't a valid URL, the app crashes immediately with a clear error instead of failing mysteriously later when the database connection is first attempted.

### One Server, Two Services

```typescript
app.route("/", api);                                      // API routes
app.use("/*", serveStatic({ root: "./dashboard/dist" })); // Static React app
```

Hono serves both the API and the built React dashboard from a single HTTP server. One port, no nginx needed.

### Graceful Shutdown

```typescript
const shutdown = async (): Promise<void> => {
  await bot.stop();
  server.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
```

This matters in production because EC2 sends `SIGTERM` before killing your process. Without this, active connections (like SSE streams) get hard-killed. The `void` before `shutdown()` discards the promise -- `process.on` expects a synchronous callback, but the shutdown work is async.

### Crash Handler

```typescript
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", reason);
  process.exit(1);
});
```

Node doesn't crash by default on unhandled promise rejections (it used to just log a warning). This forces a crash with a log, which is the correct behavior -- you want to know about unhandled errors, not silently ignore them.

---

## Config and the Lazy Singleton Pattern

**File:** `src/shared/runtime/config.ts`

```typescript
let _env: Env | null = null;

export function loadEnv(): Env {
  if (_env) return _env;
  _env = envSchema.parse(process.env);
  return _env;
}
```

This is the **lazy singleton** pattern used throughout the codebase (also in `db/index.ts`):

- The `_` prefix signals "private module state, don't export this."
- First call does the expensive work (parsing/validating). Every subsequent call returns the cached result.
- It's NOT initialized at import time -- importing the module has no side effects. The work only happens when you explicitly call `loadEnv()`.

### The REGISTERED_REPOS Transform

```typescript
REGISTERED_REPOS: z.string().default("{}").transform((val, ctx) => {
  let parsed: unknown;
  try { parsed = JSON.parse(val); } catch { /* ... */ }
  const result = z.record(z.string(), repoEntrySchema).safeParse(parsed);
  // ...
  return result.data;
}),
```

This takes a JSON string from the environment, parses it, then validates the shape with Zod. You can configure repos in `.env` as a JSON string and get full type safety. The `transform()` method converts the raw string into a typed object as part of the validation pipeline.

---

## Type System -- Const Arrays as Source of Truth

**File:** `src/shared/domain/types.ts`

```typescript
export const TASK_STATUSES = ["queued", "running", "complete", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
```

This is a TypeScript pattern called **const assertion + indexed access type**:

1. `as const` makes the array readonly and preserves literal types (not just `string[]` but `readonly ["queued", "running", ...]`)
2. `(typeof TASK_STATUSES)[number]` extracts a union type: `"queued" | "running" | ...`

**Why not just a union type?** Because the array is also used at runtime -- the database schema uses it to create Postgres enums, the API uses it for validation. One source of truth for both types and runtime values.

`STAGE_NAMES` follows the same pattern and covers every stage across every
task kind: `planner`, `implementer`, `reviewer`, `pr_creator`, `revision`,
`answering`, `pr_reviewing`. Task-level status is a simple generic lifecycle
(`queued | running | complete | failed | cancelled`); granular per-stage
status lives on the `task_stages` row, not on the task.

### SSE Event Types

```typescript
export type SSEEvent =
  | { type: "task_update"; taskId: string; status: TaskStatus }
  | { type: "stage_update"; taskId: string; stage: StageName; status: StageStatus }
  | { type: "pr_update"; taskId: string; prUrl: string }
  | { type: "pr_session_update"; prSessionId: string; running: boolean }
  | {
      type: "session_entry";
      scope: "task" | "pr_session";
      id: string;
      stage?: StageName;
      entry: FileEntry;
    };
```

This is a **discriminated union** -- the `type` field determines which shape the event has. `session_entry` carries a line freshly appended to a pi session file (see [Logging](#logging)); `scope` + `id` + optional `stage` route it to the right dashboard view.

---

## Event Bus -- Pub/Sub for SSE

**File:** `src/shared/runtime/events.ts`

```typescript
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };  // cleanup function
}

export function emit(event: SSEEvent): void {
  for (const listener of listeners) {
    try { listener(event); }
    catch (err) { log.error("SSE listener threw", err); }
  }
}
```

This is a **simple in-memory pub/sub**. The patterns at play:

- `subscribe()` returns an unsubscribe function (common in React and RxJS). The caller doesn't need to keep a reference to the listener -- they just call the returned function to clean up.
- `emit()` fans out to all listeners synchronously.
- Error in one listener doesn't break others (try/catch per listener).

This bridges the pipeline (which emits events as stages progress) to SSE (which streams them to the browser). No Redis, no message queue -- just a `Set` of callbacks. Appropriate for a single-process system.

---

## Database Layer

**Files:** `src/db/schema.ts`, `src/db/index.ts`, `src/db/queries.ts`

Three files, three responsibilities:

| File | Responsibility |
|------|---------------|
| `schema.ts` | Table definitions (the "what") |
| `index.ts` | Connection singleton (the "how to connect") |
| `queries.ts` | All reads/writes (the "what operations exist") |

### Why Drizzle ORM?

Drizzle is SQL-first -- your schema looks like SQL, your queries look like SQL. Compared to Prisma:
- No code generation step (Prisma requires `prisma generate`)
- Lighter weight, fewer abstractions between you and the database
- The Neon HTTP driver means it works over HTTP, not TCP -- important for serverless, and simpler for setup

### Schema Design

```typescript
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  repo: text("repo").notNull(),
  status: taskStatusEnum("status").notNull().default("queued"),
  instance: text("instance").notNull(),
  // ...
});
```

Key decisions:

- **UUIDs as primary keys** (not auto-incrementing integers) -- safe to expose in URLs and APIs without revealing ordering or total count.
- **`instance` column** enables multi-instance isolation -- dev and prod can share the same database without conflicts. Every query filters by `INSTANCE_ID`.
- **Postgres enums** created from the same const arrays in `types.ts` -- database-level validation matches TypeScript types.

### Connection Singleton

```typescript
let _db: Db | null = null;

export function getDb(): Db {
  if (!_db) {
    const sql = neon(loadEnv().DATABASE_URL);
    _db = drizzle(sql, { schema });
  }
  return _db;
}
```

Same lazy singleton pattern as config. The database connection is created on first use, not at import time.

### Query Patterns

```typescript
export async function createTask(data: { ... }): Promise<Task> {
  const [task] = await db
    .insert(schema.tasks)
    .values({ ...data, instance: loadEnv().INSTANCE_ID })
    .returning();
  return task;
}
```

- Every insert uses `.returning()` -- a Postgres feature that returns the inserted row, avoiding a second SELECT query.
- `updateTask` always sets `updatedAt: new Date()` -- manual timestamp management rather than database triggers.
- `listTasks` uses Drizzle's `and()` with optional conditions -- `undefined` conditions are silently dropped, so you can compose filters cleanly without `if` chains.

---

## Telegram Bot

**File:** `src/bot/index.ts`

The bot is the primary input interface. Grammy is the Telegram bot framework.

### Request Flow

```
User sends message
       |
   Auth middleware (single user only)
       |
   Is it a reply to a planner? ── yes ──> deliverReply() to pipeline
       |
      no
       |
   Parse "repoName taskDescription"
       |
   createTask() in DB
       |
   runPipeline() fire-and-forget
```

### Auth Middleware

```typescript
bot.use(async (ctx, next) => {
  if (String(ctx.from?.id) !== allowedUserId) {
    log.warn(`Unauthorized access attempt from user ${ctx.from?.id}`);
    return;  // silently drop -- no response
  }
  return next();  // proceed to handlers
});
```

`bot.use()` registers middleware that runs before every handler. If the user ID doesn't match, the request is silently dropped. This is security at the framework level, not per-handler. `next()` is the standard middleware pattern -- call it to continue, return without calling it to stop the chain.

### Active Conversations

```typescript
const activeConversations = new Map<string, string>(); // chatId -> taskId
```

Tracks which Telegram chat is conversing with which task. This enables the planner Q&A flow where the bot asks clarifying questions and the user responds naturally. When the user sends a regular text message, the bot checks if there's an active conversation first.

### Fire-and-Forget

```typescript
runPipeline(task.id, sendTelegram).catch((err) => {
  log.error(`Pipeline error for task ${task.id}`, err);
});
```

The pipeline is started **without `await`**. The bot handler returns immediately, and the pipeline runs in the background. This is crucial -- you don't want the Telegram handler to block for 30 minutes while the AI works. The `.catch()` ensures errors are logged rather than becoming unhandled rejections.

### Prefix-Based Task Lookup

```typescript
async function findTaskByPrefix(prefix: string): Promise<...> {
  const matches = tasks.filter((t) => t.id.startsWith(prefix));
  if (matches.length === 0) return { ok: false, message: `Task not found: ${prefix}` };
  if (matches.length > 1) return { ok: false, message: `Ambiguous ID...` };
  return { ok: true, task: matches[0] };
}
```

Lets users type partial task IDs (first 8 chars) instead of full UUIDs. Handles ambiguity gracefully. The return type is a **discriminated union** (`ok: true` has `task`, `ok: false` has `message`) which forces callers to check for success before accessing the task.

---

## Hono and the HTTP Server

**File:** `src/api/index.ts`

### What Is Hono?

Hono is an HTTP framework -- same category as Express, Fastify, or Koa. Its job is to take incoming HTTP requests and route them to handler functions that return responses.

The key difference from Express: Hono is built on the **Web Standard `fetch` API** rather than Node's `http.IncomingMessage`/`ServerResponse`. Handlers receive a standard `Request` and return a standard `Response` -- the same APIs browsers use. This makes it portable across runtimes (Node, Deno, Bun, Cloudflare Workers).

**Why Hono over Express?**
- Lighter and faster
- TypeScript-first with good inference
- Built-in utilities (`streamSSE`, `cors`, `serveStatic`) that Express requires separate packages for
- Modern API -- no callback hell, everything is async/await

### How the Server Is Wired Up

```typescript
const app = new Hono();
const api = createApi();            // returns another Hono instance
app.route("/", api);                // mount all API routes at root
app.use("/*", serveStatic({ root: "./dashboard/dist" }));  // fallback: serve files

const server = serve({ fetch: app.fetch, port: env.PORT }, ...);
```

Three layers:

**Layer 1: `@hono/node-server`'s `serve()`** -- the actual TCP server. Listens on port 3333, accepts HTTP connections, translates Node's native `http.IncomingMessage` into the Web Standard `Request` that Hono expects. A thin adapter -- Hono itself doesn't know or care about Node.

**Layer 2: `app.route("/", api)`** -- mounts the API routes. `createApi()` returns a separate Hono instance with all the `/api/*` routes defined. This is composition -- you build small route groups and combine them.

**Layer 3: `app.use("/*", serveStatic(...))`** -- catch-all that serves static files from `dashboard/dist/`. If no API route matched, it tries to find a file on disk. This is how the React SPA gets served.

**Order matters.** Hono matches routes top-to-bottom. API routes are checked first. If none match, the static file handler runs. `/api/tasks` hits the API. `/` or `/prs` serves `index.html`.

### The Context Object

Every handler receives a Context `c`:

```typescript
app.get("/api/tasks/:id", async (c) => {
  const task = await queries.getTask(c.req.param("id"));  // route params
  if (!task) return c.json({ error: "Not found" }, 404);  // JSON response
  return c.json({ ...task, stages });                      // 200 by default
});
```

- `c.req` -- the request (params, query strings, headers, body)
- `c.req.param("id")` -- extracts `:id` from the URL path
- `c.req.query("status")` -- extracts `?status=` from the query string
- `c.json()` -- return a JSON response with correct `Content-Type` header
- `c.text()` -- return plain text

---

## REST API Routes

All routes defined in `src/api/index.ts`:

### Data Routes

```
GET  /api/tasks                    → List all tasks (optional ?status= and ?repo= filters)
GET  /api/tasks/:id                → Get one task with its stages
GET  /api/tasks/:id/logs           → Get structured logs for all stages of a task
GET  /api/tasks/:id/artifacts/:name → Read a file from artifacts/<id>/<name>
POST /api/tasks/:id/retry          → Re-run a failed task
POST /api/tasks/:id/cancel         → Cancel a running task
GET  /api/repos                    → List registered repos
GET  /api/prs                      → List all tasks that produced PRs
GET  /api/events                   → SSE stream (persistent connection)
```

This is standard **REST** layout. Nouns are resources (`tasks`, `repos`, `prs`), HTTP verbs indicate the operation (`GET` = read, `POST` = action).

### Path Traversal Prevention

The artifacts endpoint has three layers of defense:

```typescript
app.get("/api/tasks/:id/artifacts/:name", async (c) => {
  const { id, name } = c.req.param();

  // Layer 1: Regex -- ID must be a UUID
  if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "Not found" }, 404);

  // Layer 2: Regex -- name must be simple filename, no dots at start
  if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) return c.json({ error: "Not found" }, 404);

  // Layer 3: Resolved path must stay within artifacts directory
  const base = path.resolve(config.artifactsDir);
  const filePath = path.resolve(path.join(base, id, name));
  if (!filePath.startsWith(base + path.sep)) return c.json({ error: "Not found" }, 404);
  // ...
});
```

This prevents attacks like `../../etc/passwd`. Defense in depth -- any one layer is probably enough, but all three together make it robust.

### Dashboard Retry (No Telegram)

```typescript
app.post("/api/tasks/:id/retry", async (c) => {
  // ...
  const noopSend = async (_chatId: string, _text: string): Promise<void> => {};
  runPipeline(task.id, noopSend).catch(/* ... */);
});
```

When retrying from the dashboard (not Telegram), there's no bot instance to send messages through. Instead of threading the bot everywhere, it uses a no-op function. Clean separation of concerns.

---

## Server-Sent Events (SSE)

The SSE endpoint is fundamentally different from the REST routes. It's a **persistent connection** that pushes data to the client.

```typescript
app.get("/api/events", (c) => {
  return streamSSE(c, async (stream) => {
    // 1. Subscribe to the in-memory event bus
    const unsubscribe = subscribe((event) => {
      stream.writeSSE({
        data: JSON.stringify(event),
        event: event.type,
      }).catch(() => {});
    });

    // 2. Keep-alive ping every 30s
    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: "", event: "ping" }).catch(() => {});
    }, 30_000);

    // 3. Clean up when client disconnects
    stream.onAbort(() => {
      unsubscribe();
      clearInterval(keepAlive);
    });

    // 4. Block forever -- keep the connection open
    await new Promise(() => {});
  });
});
```

### What Is SSE?

SSE (Server-Sent Events) is a browser-native protocol for server-to-client push. Unlike WebSockets (bidirectional), SSE is one-way: server pushes, client listens. The browser's `EventSource` API handles it natively -- reconnection, parsing, event types -- all built in.

### The Wire Format

SSE is plain text over HTTP:

```
event: task_update
data: {"type":"task_update","taskId":"abc","status":"running"}

event: ping
data:

```

Each event has a type and data, separated by double newlines. The browser parses this automatically.

### The "Block Forever" Idiom

```typescript
await new Promise(() => {});
```

This creates a promise that **never resolves**, keeping the async function alive indefinitely. The connection stays open until the client disconnects (triggering `onAbort`). This is the standard pattern for SSE handlers.

### Keep-Alive

The 30-second ping prevents proxies and load balancers from killing idle connections. Many reverse proxies (nginx, AWS ALB) close connections that haven't sent data recently.

### Why SSE Instead of WebSockets?

For one-way push (which is all the dashboard needs), SSE is simpler:
- No handshake upgrade protocol
- No ping/pong framing to implement
- Works through HTTP proxies without special configuration
- Auto-reconnection built into the browser API
- WebSockets would be overkill here

---

## The Pipelines -- Core Orchestration

**Directory:** `src/pipelines/`

There is no single pipeline anymore. Every inbound Telegram message is
classified (`src/bot/classifier.ts`) into one of three task kinds; each kind
has its own pipeline file.

| Kind | File | Stages |
|---|---|---|
| `coding_task` | `pipelines/coding/pipeline.ts` | `planner` -> `implementer` -> `reviewer`, then hands off to a PR session |
| `codebase_question` | `pipelines/question/pipeline.ts` | `answering` (read-only, no worktree) |
| `pr_review` | `pipelines/pr-review/pipeline.ts` | `pr_impact` -> `pr_analyst`, then hands off to a PR session via `pr-session/session.ts#handoffExternalReview` |

All three use `core/stage.ts#runStage` to spawn a pi RPC subprocess, tail
its native session file into SSE, and enforce a 30-minute timeout.
`runStage` is where the real shared orchestration lives.

### Coding pipeline flow

```
runPipeline(taskId)
    |
    syncRepo()         fetch origin, reset main to origin/main
    createWorktree()   fresh worktree on goodboy/<slug>-<taskId[:8]>
    |
    +---------------------------------------------+
    |  Stage 1: Planner                           |
    |    runStage() spawns pi RPC subprocess      |
    |    Loads pi-subagents extension (only here) |
    |    Writes plan.md                           |
    +---------------------------------------------+
    |  Stage 2: Implementer                       |
    |    Reads plan.md, writes code, git commits  |
    |    Writes implementation-summary.md         |
    +---------------------------------------------+
    |  Stage 3: Reviewer                          |
    |    Reads plan + summary, runs git diff main |
    |    Fixes issues, writes review.md           |
    +---------------------------------------------+
    |
    task marked complete, ownership of the        
    worktree transferred to a new PR session      
    (pipelines/pr-session/session.ts)             
```

There is no task-level concurrency control at the moment -- tasks start as
soon as they are created. If you re-introduce a concurrency limit, it belongs
next to `runStage` in `core/stage.ts`, not inside an individual pipeline.

### PR sessions

**Files:** `pipelines/pr-session/session.ts` and `pipelines/pr-session/poller.ts`

Once the coding pipeline (or pr-review pipeline) finishes, the worktree is
not torn down. Instead, ownership is handed to a `PrSession` row whose
`mode` column distinguishes the two flavors:

- `mode = "own"` -- created by `startPrSession` after the coding reviewer
  stage. Pushes the branch, opens the PR, records `prNumber`.
- `mode = "review"` -- created by `handoffExternalReview` after the
  pr-review pipeline's analyst posts its review. Thin handoff: persists the
  session row and transfers worktree ownership; pi creates the JSONL on the
  first comment-resume.
- `resumePrSession` -- re-opens the same pi session (via `--session <path>`)
  when the poller detects new human comments. Reads `prSession.mode` to
  pick the right system prompt. The poller (`poller.ts`) runs every 3
  minutes and merges three comment sources from `core/git/github.ts`:
  - `getPrComments` -- top-level conversation comments (`kind: "conversation"`)
  - `getPrReviewComments` -- inline code comments with file/line (`kind: "inline"`)
  - `getPrReviews` -- submitted review bodies with state (`kind: "review_summary"`)
  Bots are filtered. The cursor advances using a pre-fetch timestamp
  rewound by a 5s safety window so comments arriving mid-fetch are still
  picked up on the next tick.

Dismissing a `pr_review` task is mode-aware: it never closes the upstream
PR or deletes its remote branch, since both belong to the PR author.
Local-only cleanup (worktree + session JSONL) runs as usual.

Session state lives on disk at `data/pr-sessions/<prSessionId>.jsonl`, which
is pi's native session file. The resumed pi process gets full conversation
context from it, and the dashboard reads/tails the same file for the
transcript -- one source of truth.

### Artifact-based inter-stage communication

Stages don't communicate through function returns or shared memory. They
write files to `artifacts/<taskId>/`:

- `plan.md` -- planner writes, all others read
- `implementation-summary.md` -- implementer writes, reviewer reads
- `review.md` -- reviewer writes, PR session reads for the PR description

**Why files instead of passing data in memory?**
- Each stage is an independent subprocess (different pi RPC process) -- no shared memory
- Files are inspectable for debugging -- you can read what any stage produced
- If a stage fails, you can examine the artifacts it left behind
- Makes retry logic simpler -- just re-run the stage, it reads fresh artifacts

`requireArtifact()` in `pipelines/coding/pipeline.ts` validates the file
exists and isn't empty before proceeding to the next stage.

### No planner conversation loop

Earlier designs had the planner ask clarifying questions via Telegram
(`{status: "needs_input", questions: [...]}`) and block on a `waitForReply`
promise. That loop has been removed. Stage completion is now detected via pi's
`agent_end` RPC event -- not a text marker. Prompts still ask the model to
emit `{"status": "complete"}` at the end for human readability, but nothing
parses it. If you need a human-in-the-loop step again, add it inside
`runStage` -- do not rebuild it per pipeline.

### Timeout pattern

```typescript
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}
```

`Promise.race` -- whichever promise settles first wins. If the timer fires before the stage completes, the whole thing rejects. `.finally()` ensures the timer is cleaned up either way. This is the standard pattern for adding timeouts to promises in JavaScript.

---

## Pi RPC -- Process Management

**Directory:** `src/core/pi/`

pi RPC is a thin wrapper. Everything structured -- message history, tool
calls, tool results, subagent details -- is written by pi into its own
session JSONL file and consumed from there (see [Logging](#logging)). The
RPC channel exists only to send the initial prompt, auto-confirm extension
UI prompts, and detect `agent_end`.

| File | Role |
|---|---|
| `session.ts` | Spawns the pi process, wires stdin/stdout/stderr, exposes `sendPrompt` / `waitForCompletion` / `waitForExit` / `kill`. |
| `jsonl-reader.ts` | Chunked stdout -> complete lines (handles `\r\n`, partial chunks). |

This spawns `pi` (the coding agent) as a **child process** communicating over stdin/stdout with JSON lines (JSONL):

```
Node process (Goodboy)
    |
    spawn("pi", ["--mode", "rpc", ...])
    |
    stdin  ──> JSON commands (prompts, abort)
    stdout <── JSON events (text deltas, tool calls, completion)
    stderr <── debug logs
```

### JSONL Protocol

JSONL means "one JSON object per line." The `attachJsonlReader` function handles a subtle problem: data from a child process arrives in arbitrary **chunks**, not neat lines. You might get half a JSON object in one chunk and the rest in the next.

```typescript
function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
  });
}
```

It buffers incoming data and splits on newlines, emitting complete lines only.

### Promise-Based Completion Model

```typescript
let resolveCompletion: (() => void) | null = null;

// In handleEvent:
if (event.type === "agent_end") {
  resolveCompletion?.();
}

// Public API:
waitForCompletion() {
  return new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
}
```

`resolveCompletion` is stored as module state. When the `agent_end` event arrives from the child process, it resolves the promise. This bridges the event-driven child process output to an await-friendly API that the pipeline can use with `await session.waitForCompletion()`. All structured output (messages, tool calls, results) is written to the session file by pi; `waitForCompletion` only needs to know the agent finished.

### Session Lifecycle

```typescript
kill() {
  // 1. Graceful: send abort command
  proc.stdin!.write(JSON.stringify({ type: "abort" }) + "\n");

  // 2. Forceful fallback: SIGTERM after 2 seconds
  const killTimer = setTimeout(() => {
    if (proc.exitCode === null) proc.kill("SIGTERM");
  }, 2000);
  proc.once("exit", () => clearTimeout(killTimer));
}
```

Belt and suspenders -- try the polite way first, then force-kill if it doesn't respond.

---

## Logging

**Files:** `src/core/session-file.ts`, `src/core/session-broadcast.ts`, `src/shared/contracts/session.ts`.

Logs are pi's native session JSONL files. We don't translate, we don't
re-shape, we don't store a parallel log format. Every stage tells pi to
write its session to an absolute path:

```
artifacts/<taskId>/<stage>.session.jsonl   -- one file per stage
data/pr-sessions/<prSessionId>.jsonl       -- one file per PR session
```

Each line is a typed `FileEntry` from `@mariozechner/pi-coding-agent`:
a `SessionHeader` header line, then `SessionEntry` lines that tree up into
user messages, assistant messages (with text, thinking, and tool-call
content blocks), tool results, bash executions, model changes, compactions,
etc. The format is documented in
[pi's `session.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md).

### Persistence behaviour

Pi buffers entries in memory until the **first assistant message** arrives;
once that happens, it flushes everything and appends every subsequent entry
synchronously. The practical impact:

- Tools (read, edit, bash, write) appear in the file within milliseconds of completing.
- Subagent calls only produce one `toolResult` entry when the whole fan-out finishes -- we sacrificed live per-worker progress when we dropped the RPC event translator. The final result still contains per-worker usage and output via `details.results[]`.
- The file is silent for the first few seconds of a stage (dashboard shows `waiting for output...`).

### Reading + tailing

`core/session-file.ts` exposes:

- `taskSessionPath(taskId, stage)` / `prSessionPath(prSessionId)` -- path helpers.
- `readSessionFile(path)` -- one-shot parse; returns `[]` if the file is missing.
- `watchSessionFile(path, onEntry)` -- poll + `fs.watch` hybrid that maintains a byte offset, parses newly appended lines, emits each as a typed entry. Returns a disposer.

`core/session-broadcast.ts` wires `watchSessionFile` to the SSE bus: every
appended entry fans out as a `session_entry` event. `runStage` starts one
broadcast per stage; `runSessionTurn` starts one per PR-session turn. Both
stop it in their `finally` block.

### API + frontend

- `GET /api/tasks/:id/session` -> `{ stages: [{ stage, entries }] }` -- reads every `<stage>.session.jsonl` for a task.
- `GET /api/pr-sessions/:id/session` -> `{ entries }` -- reads the PR session file.
- SSE `session_entry` events stream new lines as they're appended.

The dashboard's `useLiveSession` hook buckets those SSE entries by a
caller-supplied key. Pages merge the on-disk snapshot with the live bucket
and dedupe by entry `id` (pi guarantees uniqueness) -- no seq counters, no
sort-on-read, no write queues. See [Dashboard](#dashboard-architecture).

---

## Git Worktrees

**File:** `src/core/worktree.ts`

### Why Worktrees Instead of `git clone`?

A worktree is a lightweight second checkout of the same repo:
- Shares the `.git` directory with the original -- no duplicate history
- Much faster than cloning (no network, no downloading)
- Changes in the worktree don't affect your main checkout
- Branch isolation is automatic

### Retry Safety

```typescript
export async function createWorktree(repoPath, branch, taskId): Promise<string> {
  // Always start clean
  try { await exec("git", ["worktree", "remove", worktreeDir, "--force"], ...); } catch {}
  try { await exec("git", ["branch", "-D", branch], ...); } catch {}

  // Fresh start
  await exec("git", ["worktree", "add", "-b", branch, worktreeDir], ...);
  return worktreeDir;
}
```

Always removes existing worktrees/branches first. Retrying a failed task gets a clean slate, not leftover half-committed code from the previous attempt.

### Branch Naming

```typescript
export function generateBranchName(taskId: string, description: string): string {
  const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "task";
  return `goodboy/${slug}-${taskId.slice(0, 8)}`;
}
```

Produces branches like `goodboy/add-dark-mode-toggle-a1b2c3d4`. The `goodboy/` prefix makes them easily identifiable and filterable in GitHub.

---

## Prompt Engineering

**Files:** `src/core/prompts.ts` (shared fragments) and
`src/pipelines/<kind>/prompts.ts` (per-kind stage prompts).

Each pipeline stage gets a **system prompt** (defines behavior) and an
**initial prompt** (kicks off the work). The `SHARED_RULES` and
`WORKTREE_CONTEXT` fragments live in `core/prompts.ts` and are composed into
every per-kind prompt file.

### Shared Rules

```typescript
const SHARED_RULES = `
CRITICAL RULES:
- Do NOT shell out to other AI tools (claude, copilot, cursor, aider, etc.)
- Do NOT read or follow CLAUDE.md, AGENTS.md, or any agent config files in the repo
- Use only the built-in read, write, edit, and bash tools
- Stay focused on the task
`;
```

Every stage is told not to shell out to other AI tools and not to read project agent config files. This prevents recursive agent invocation and prompt injection from repo configs.

### Worktree Context

```typescript
const WORKTREE_CONTEXT = `
You are working in a git worktree -- a fresh checkout with NO installed dependencies.
If you need to run code, install dependencies first.
Do NOT spend excessive time on runtime verification.
`;
```

Explicitly tells the AI it's in a fresh checkout with no deps installed. Without this, the AI would waste time trying to run code that can't execute.

### Artifact Paths

```typescript
YOU MUST write the plan to this exact file path using the write tool:
  ${artifactsDir}/plan.md
```

Absolute file paths for artifacts -- the AI knows exactly where to write, no ambiguity.

### Stage completion signal

Stages are considered complete when pi emits the `agent_end` RPC event.
Prompts still ask the model to print `{"status": "complete"}` as a
human-readable end marker, but nothing parses it -- the earlier
`needs_input` / `ready` text-marker protocol was removed along with the
planner conversation loop.

---

## Dashboard Architecture

**Files:** `dashboard/src/`

The dashboard is a **static SPA** served by the backend. No SSR, no server components -- just client-side React.

**Stack:** Vite 8 + React 19 + Tailwind v4 + React Router.

### File layout

```
dashboard/src/
  main.tsx              Bootstraps <BrowserRouter> + <ErrorBoundary> + <App>.
  App.tsx               Route table.
  shared.ts             Re-exports backend enums / wire types (never duplicate).
  index.css             Tailwind theme tokens + global animations.

  lib/
    api/                request() client, per-resource endpoints, TASK_KIND_CONFIG.
    task-grouping.ts    Pure: today / yesterday / this week buckets.
    format.ts           Pure: timeAgo, formatDuration, formatTokens, formatTime.
    constants.ts        SSE_RETRY_MS, LOG_SCROLL_EPSILON_PX, ...
    utils.ts            cn, shortId.

  hooks/
    use-query.ts         Minimal fetch state machine with stale-response guard.
    use-sse.ts           Singleton EventSource; shared across all subscribers.
    use-live-session.ts  Buckets SSE `session_entry` events by a caller-supplied key.
    use-now.ts           Periodic `Date.now()` tick for live relative-time text.

  components/
    Layout.tsx          Floating nav + centered main column.
    PageState.tsx       Three-state guard (loading / error / empty / ready).
    ErrorBoundary.tsx   Top-level uncaught-error screen.
    StatusBadge.tsx     One pill for task / session / run statuses.
    PipelineProgress.tsx, Card.tsx, SectionDivider.tsx, EmptyState.tsx,
    Markdown.tsx, TaskRow.tsx
    rows/               PrSessionRow, PrRow, RepoRow, RunCard
    log-viewer/         LogViewer, MessageEntry, UserBubble,
                        AssistantTurn, ToolCallCard, SubagentCard,
                        BashExecutionCard, OutcomePill, helpers.ts
                        (renders pi's native session entries directly)

  pages/
    Tasks.tsx, TaskDetail.tsx, PullRequests.tsx, PrSessionDetail.tsx, Repos.tsx
```

Dependency direction: `pages/` -> `components/` + `hooks/` -> `lib/` -> `shared.ts` -> backend `src/shared/domain/types.ts`. The path alias `@shared/*` wires that last hop; types are re-exported through `dashboard/src/shared.ts` so pages and components never import from outside `dashboard/src` directly.

### Shared wire types

`dashboard/src/shared.ts` is a narrow re-export of `src/shared/domain/types.ts` and `src/shared/contracts/session.ts` (`TaskKind`, `TaskStatus`, `StageStatus`, `StageName`, `SSEEvent`, `FileEntry`, `SessionEntry`, `SessionMessageEntry`, ...). The dashboard never redeclares these. When the backend adds a new `TaskKind`, TypeScript fails on the dashboard's `TASK_KIND_CONFIG` until every kind has a label, a stage list, and an artifact list.

### Log viewer

The viewer consumes pi's native `FileEntry[]` directly -- no re-grouping, no
correlation step. Data flow:

```
session file -> readSessionFile / SSE -> dedupeById by entry.id
             -> visibleEntries (drop session/model_change/etc.)
             -> buildToolResultIndex (toolCallId -> toolResult message)
             -> render one <MessageEntry> per entry
```

`MessageEntry` routes on the entry type and (for `message` entries) on
`message.role`. Tool calls are rendered inside `AssistantTurn` and pull their
matching `ToolResultMessage` from the index, so a tool call + its result
display together even though they live in separate session lines. The
`subagent` tool has its own richer card that reads `details.results[]` off
the `ToolResultMessage`.

Tiny pure helpers (`helpers.ts`: `visibleEntries`, `dedupeById`,
`buildToolResultIndex`, `joinText`) are the testable slice -- no React, no
IO.

### Three-state guard

`<PageState data loading error onRetry isEmpty empty>` wraps every data-backed page. It renders a spinner while `loading && !data`, an error message with a retry button while `error && !data`, an `<EmptyState>` when `isEmpty(data)` is true, and otherwise calls `children(data)`. This is the AGENTS rule made into a single component.

### useQuery

Minimal fetch state machine. A `callId` ref prevents stale responses from overwriting fresh ones when the user fires requests A then B and A returns after B.

### useSSE + useSSERefresh + useLiveSession

`useSSE` manages a **singleton `EventSource`** shared across all subscribers; it auto-reconnects with `SSE_RETRY_MS` backoff and auto-closes when the last subscriber unmounts.

```ts
useSSERefresh(refetch, (e) => e.type === "task_update");  // refetch on match
```

Why refetch instead of mutating state from SSE? SSE is a "something changed" signal; the REST API is the single source of truth. Avoids two state machines for the same data.

`useLiveSession({ match })` buckets streamed `session_entry` events by a caller-supplied key (stage name, task id, session id, ...). Pages merge the bucket with the on-disk snapshot and dedupe by `entry.id` -- one hook covers both task-detail and PR-session views.

### API client

`lib/api/` is split by resource (`tasks.ts`, `pr-sessions.ts`, `repos.ts`, `memory.ts`) around a shared `request<T>()` wrapper in `client.ts`. Types live in `types.ts`. A barrel re-exports everything so callers still import from `@dashboard/lib/api`.

URLs are **relative** (`/api/tasks`, not `http://localhost:3333/api/tasks`):
- **Production:** Hono serves the built SPA from the same host, so relative paths resolve locally.
- **Development:** Vite's `proxy` config forwards `/api` to `http://localhost:3333`.

---

## How the Frontend Connects to the Backend

### Page Load Flow

When you open the dashboard at `/`:

```
1. Browser requests GET /
2. Hono: no API route matches -> serveStatic serves dashboard/dist/index.html
3. Browser loads React app (main.js, CSS)
4. React Router renders <Tasks /> component
5. Tasks calls useQuery(() => fetchTasks())
6. Browser fetches GET /api/tasks -> Hono handler -> Neon DB query -> JSON response
7. React renders the task list
8. useSSERefresh opens GET /api/events (EventSource)
9. Connection stays open, waiting for push events
```

### Real-Time Update Flow

When a pipeline stage completes:

```
1. Pipeline calls emit({ type: "task_update", taskId, status })    <- events.ts pub/sub
2. SSE listener in api/index.ts picks it up
3. stream.writeSSE({ data: JSON.stringify(event), event: "task_update" })
4.     ~~~~ HTTP chunked response over the wire ~~~~
5. Browser's EventSource receives it
6. useSSE hook dispatches to React listeners
7. useSSERefresh calls refetch()
8. Browser fetches GET /api/tasks again
9. React re-renders with updated status
```

The user sees the task status change in real-time without refreshing the page.

---

## The One-Server Trick

The entire system -- API, SSE, and static file serving -- runs on **one HTTP server, one port (3333)**:

```
Browser -> :3333 -> Hono
                     |-- /api/*       -> REST handlers
                     |-- /api/events  -> SSE stream
                     +-- /*           -> dashboard/dist/ (React SPA)
```

No nginx, no reverse proxy, no separate frontend server. `node dist/index.js` and you're running.

The tradeoff: you lose some production-grade features (gzip, HTTP/2, request buffering). For a single-user tool, those don't matter.

---

## Patterns Worth Internalizing

| Pattern | Where | Why |
|---------|-------|-----|
| Lazy singleton with `_` prefix | `config.ts`, `db/index.ts` | No side effects on import, initialize once |
| Zod validation at boundaries | `config.ts`, API params | Crash early with clear errors |
| Const arrays as type source of truth | `types.ts` | One definition for types AND runtime values |
| Pub/sub with cleanup returns | `events.ts`, `useSSE` | Memory-leak-proof subscriptions |
| Fire-and-forget with `.catch()` | `bot/index.ts` | Don't block the handler, but don't lose errors |
| JSONL over stdio for IPC | `core/pi/session.ts` + `core/pi/jsonl-reader.ts` | Language-agnostic, streamable, debuggable |
| Artifact files for inter-process data | `pipelines/coding/pipeline.ts` | Inspectable, restartable, no shared memory needed |
| `Promise.race` for timeouts | `core/stage.ts#withTimeout` | Standard async timeout pattern |
| Pure parsers separated from IO | `core/github.ts`, `core/session-file.ts`, `dashboard/.../helpers.ts` | The key testability pattern -- extend to every new file |
| Path traversal prevention | `api/index.ts` | Defense in depth for file-serving endpoints |
| Ref trick for stable callbacks | `useSSE`, `useQuery` | Avoid stale closures in React effects |
| Discriminated unions | `types.ts`, bot prefix lookup | Force callers to handle all cases |
| `await new Promise(() => {})` | SSE handler | "Block forever" idiom for persistent connections |
