# Goodboy Architecture Guide

A comprehensive walkthrough of the Goodboy codebase -- architecture, engineering decisions, patterns, and how everything connects.

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

**File:** `src/shared/config.ts`

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

**File:** `src/shared/types.ts`

```typescript
export const TASK_STATUSES = ["queued", "planning", ...] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
```

This is a TypeScript pattern called **const assertion + indexed access type**:

1. `as const` makes the array readonly and preserves literal types (not just `string[]` but `readonly ["queued", "planning", ...]`)
2. `(typeof TASK_STATUSES)[number]` extracts a union type: `"queued" | "planning" | ...`

**Why not just a union type?** Because the array is also used at runtime -- the database schema uses it to create Postgres enums, the API uses it for validation. One source of truth for both types and runtime values.

### Stage-to-Status Mapping

```typescript
export const STAGE_TO_STATUS: Record<StageName, TaskStatus> = {
  planner: "planning",
  implementer: "implementing",
  reviewer: "reviewing",
  pr_creator: "creating_pr",
  revision: "revision",
};
```

This connects pipeline stages to task statuses -- when the implementer starts, the task status becomes `"implementing"`. Using a typed `Record` ensures every stage has a mapping and every value is a valid status.

### SSE Event Types

```typescript
export type SSEEvent =
  | { type: "task_update"; taskId: string; status: TaskStatus }
  | { type: "stage_update"; taskId: string; stage: StageName; status: StageStatus }
  | { type: "log"; taskId: string; stage: StageName; entry: LogEntry }
  | { type: "pr_update"; taskId: string; prUrl: string };
```

This is a **discriminated union** -- the `type` field determines which shape the event has. TypeScript can narrow the type in `if`/`switch` branches based on `type`.

---

## Event Bus -- Pub/Sub for SSE

**File:** `src/shared/events.ts`

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
data: {"type":"task_update","taskId":"abc","status":"implementing"}

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

## The Pipeline -- Core Orchestration

**File:** `src/orchestrator/pipeline.ts`

This is the brain of the system.

### Pipeline Flow

```
runPipeline(taskId)
    |
    acquireSlot() ── blocks if 2 tasks already running
    |
    createWorktree() ── fresh git checkout
    |
    +---------------------------------------------+
    |  Stage 1: Planner                           |
    |    Spawns pi RPC subprocess                 |
    |    Explores codebase, writes plan.md        |
    |    May ask questions via Telegram            |
    |    Waits for /go confirmation                |
    +---------------------------------------------+
    |  Stage 2: Implementer                       |
    |    Reads plan.md, writes code, git commits  |
    |    Writes implementation-summary.md         |
    +---------------------------------------------+
    |  Stage 3: Reviewer                          |
    |    Reads plan + summary, reviews code       |
    |    Fixes issues, writes review.md           |
    +---------------------------------------------+
    |  Stage 4: PR Creator                        |
    |    Pushes branch, creates GitHub PR         |
    +---------------------------------------------+
    |
    releaseSlot()
```

### Concurrency Control -- Manual Semaphore

```typescript
const waitingForSlot: Array<() => void> = [];
let runningCount = 0;

async function acquireSlot(): Promise<void> {
  if (runningCount < config.maxParallelTasks) {
    runningCount++;
    return;
  }
  await new Promise<void>((resolve) => {
    waitingForSlot.push(resolve);
  });
  runningCount++;
}

function releaseSlot(): void {
  runningCount--;
  const next = waitingForSlot.shift();
  if (next) next();
}
```

This is a **semaphore implemented with promises**. When all slots are full, `acquireSlot()` creates a promise and stores its resolver in the queue. When a slot opens, `releaseSlot()` calls the next waiting resolver, which unblocks the waiting pipeline. Max 2 parallel tasks prevents overloading the machine.

This is a fundamental concurrency primitive -- worth studying and understanding deeply.

### Artifact-Based Inter-Stage Communication

Stages don't communicate through function returns or shared memory. They write files to `artifacts/<taskId>/`:

- `plan.md` -- planner writes, all others read
- `implementation-summary.md` -- implementer writes, reviewer + pr_creator read
- `review.md` -- reviewer writes, pr_creator reads

**Why files instead of passing data in memory?**
- Each stage is an independent subprocess (different pi RPC process) -- no shared memory
- Files are inspectable for debugging -- you can read what any stage produced
- If a stage fails, you can examine the artifacts it left behind
- Makes retry logic simpler -- just re-run the stage, it reads fresh artifacts

`requireArtifact()` validates the file exists and isn't empty before proceeding to the next stage.

### The Planner Conversation Loop

```typescript
while (marker?.status === "needs_input") {
  await sendTelegram(chatId, questions);
  const reply = await waitForReply(taskId);
  session.sendPrompt(reply);
  result = await withTimeout(session.waitForCompletion(), ...);
  marker = result.marker;
}
```

This is a **human-in-the-loop pattern**. The AI can ask clarifying questions, the pipeline pauses, the user responds via Telegram, the answer is fed back. The loop continues until the planner is satisfied.

`waitForReply()` returns a promise that resolves when `deliverReply()` is called from the bot handler -- bridging async Telegram messages to the pipeline's control flow:

```typescript
function waitForReply(taskId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(taskId);
      reject(new Error("Timed out waiting for user reply (1h)"));
    }, REPLY_TIMEOUT_MS);

    pendingReplies.set(taskId, {
      resolve: (reply) => { clearTimeout(timer); resolve(reply); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
  });
}
```

### Timeout Pattern

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

**File:** `src/orchestrator/pi-rpc.ts`

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
let resolveCompletion: ((result: ...) => void) | null = null;

// In handleEvent:
if (event.type === "agent_end") {
  resolveCompletion?.({ marker: extractMarker(fullOutput), fullOutput });
}

// Public API:
waitForCompletion() {
  return new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
}
```

`resolveCompletion` is stored as module state. When the `agent_end` event arrives from the child process, it resolves the promise. This bridges the event-driven child process output to an await-friendly API that the pipeline can use with `await session.waitForCompletion()`.

### Structured Logging

Every tool invocation is tracked:

```typescript
if (event.type === "tool_execution_start") {
  activeTools.set(toolCallId, Date.now());  // start timer
  emitLog("tool_start", summary, { tool: toolName, args });
}

if (event.type === "tool_execution_end") {
  const durationMs = Date.now() - startTime;
  emitLog("tool_end", `${toolName} done`, { tool: toolName, ok: !isError, durationMs });
}
```

This feeds into the dashboard's log viewer, showing exactly what the AI is doing in real-time.

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

### Marker Extraction

```typescript
function extractMarker(text: string): PiOutputMarker | null {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (["needs_input", "complete", "ready"].includes(parsed.status)) {
        return parsed as PiOutputMarker;
      }
    } catch { /* not JSON */ }
  }
  return null;
}
```

Scans the AI's output **backwards** for a JSON status marker. This is how the pipeline knows if the planner wants user input, is ready for confirmation, or is done.

---

## Git Worktrees

**File:** `src/orchestrator/worktree.ts`

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

**File:** `src/orchestrator/prompts.ts`

Each pipeline stage gets a **system prompt** (defines behavior) and an **initial prompt** (kicks off the work).

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

### JSON Markers as Control Protocol

```typescript
If the task is unclear, output: {"status": "needs_input", "questions": [...]}
For complex tasks needing confirmation: {"status": "ready", "summary": "..."}
Otherwise, after writing plan.md: {"status": "complete"}
```

The AI outputs structured JSON that the pipeline parser picks up via `extractMarker()`. This is the communication protocol between the AI agent and the orchestrator.

---

## Dashboard Architecture

**Files:** `dashboard/src/`

The dashboard is a **static SPA** (Single Page Application) served by the backend. No SSR, no server components -- just client-side React.

**Stack:** Vite 8 + React 19 + Tailwind v4 + React Router

### useQuery Hook

**File:** `dashboard/src/hooks/use-query.ts`

A minimal data fetching hook:

```typescript
const callId = useRef(0);

const execute = useCallback(async () => {
  const id = ++callId.current;
  setLoading(true);
  try {
    const result = await fn();
    if (id === callId.current) setData(result);  // only update if still current
  } catch (err) {
    if (id === callId.current) setError(...);
  } finally {
    if (id === callId.current) setLoading(false);
  }
}, deps);
```

The `callId` ref prevents stale responses. If you fire request A then request B, and A returns after B, the check `id === callId.current` prevents A's stale data from overwriting B's fresh data.

### useSSE Hook

**File:** `dashboard/src/hooks/use-sse.ts`

Manages a **singleton EventSource** connection:

```typescript
const listeners = new Set<Listener>();
let es: EventSource | null = null;

function ensureConnected(): void {
  if (es) return;
  es = new EventSource("/api/events");
  // ...
  es.onerror = () => {
    es?.close();
    es = null;
    retryTimeout = setTimeout(ensureConnected, 3000);  // auto-reconnect
  };
}
```

Key design:
- **One SSE connection** shared across all components (not one per hook call)
- **Auto-reconnects** on error with 3-second backoff
- **Auto-disconnects** when no listeners remain (cleanup)

The ref pattern solves a React closure problem:

```typescript
const ref = useRef(onEvent);
ref.current = onEvent;

useEffect(() => {
  const handler: Listener = (e) => ref.current(e);
  listeners.add(handler);
  // ...
}, []);
```

Without the ref, the `onEvent` callback captured by the effect closure would be stale (frozen at the value from the first render). The ref always points to the latest callback.

### useSSERefresh

```typescript
useSSERefresh(refetch, (e) => e.type === "task_update");
```

Says: "whenever a `task_update` SSE event arrives, call `refetch()` to re-query the API." The component re-renders with fresh data.

**Why refetch instead of updating state directly from SSE?** The SSE events are lightweight signals (just "something changed"). The full data comes from the REST API. This avoids having two sources of truth -- the API response is always authoritative, SSE just tells you _when_ to check again.

### API Client

**File:** `dashboard/src/lib/api.ts`

A thin HTTP client that mirrors backend types manually:

```typescript
export async function fetchTasks(...): Promise<Task[]> {
  return request(`/api/tasks${qs ? `?${qs}` : ""}`);
}
```

URLs are **relative** (`/api/tasks`, not `http://localhost:3333/api/tasks`). This works because:
- **Production:** the React app is served from the same Hono server, so relative URLs go to the same host
- **Development:** Vite's `proxy` config in `vite.config.ts` forwards `/api` requests to `http://localhost:3333`

Types are duplicated between backend and frontend. There's no code generation. This is a tradeoff: simpler tooling vs. risk of type drift. For a solo project at this scale, it's the right call.

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
| Promise-based semaphore | `pipeline.ts` | Simple concurrency control without external libraries |
| Fire-and-forget with `.catch()` | `bot/index.ts` | Don't block the handler, but don't lose errors |
| JSONL over stdio for IPC | `pi-rpc.ts` | Language-agnostic, streamable, debuggable |
| Artifact files for inter-process data | `pipeline.ts` | Inspectable, restartable, no shared memory needed |
| `Promise.race` for timeouts | `pipeline.ts` | Standard async timeout pattern |
| Path traversal prevention | `api/index.ts` | Defense in depth for file-serving endpoints |
| Ref trick for stable callbacks | `useSSE`, `useQuery` | Avoid stale closures in React effects |
| Discriminated unions | `types.ts`, bot prefix lookup | Force callers to handle all cases |
| `await new Promise(() => {})` | SSE handler | "Block forever" idiom for persistent connections |
