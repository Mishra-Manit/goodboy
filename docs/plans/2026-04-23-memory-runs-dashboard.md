# Memory Runs Table + Dedicated `/memory` Dashboard Page Implementation Plan

**Goal:** Surface every memory run (cold, warm, skip, noop) — including runs triggered by the manual test runners — as first-class entities on a new `/memory` dashboard page. Keep this history separate from task execution details so the existing task views stay task-centric while memory gets its own operational history.

**Approach:** Introduce a dedicated `memory_runs` table that records each run's source, kind, status, repo, sha, zone count, and session transcript path. `task_stages` continues to represent the per-task pipeline timeline; `memory_runs` becomes the durable per-memory-execution history. The dashboard gets a new `/memory` page that groups all visible runs by repo, shows registered-repo memory status when available, and expands each run into its transcript. Test-runner runs remain separate from `tasks`: they are identified by `instance LIKE 'TEST-%'`, stored in `memory_runs`, and surfaced only on `/memory`.

**Stack:** TypeScript · Drizzle · Hono · React + react-router · existing pi session log viewer.

---

## Locked design decisions

1. **No new environment enum.** `INSTANCE_ID` already carries environment identity. Test runs are identified solely by the `TEST-<hex>` prefix in `instance`.
2. **No stub `tasks` rows for test runs.** Manual memory tests live only in `memory_runs`; they never appear in the Tasks list or task detail pages.
3. **`task_stages` stays task-only.** A best-effort insert is used anywhere memory code tries to write a `task_stages` row for a non-task-backed run.
4. **Task pipeline and memory history remain separate views.** `TaskDetail` keeps showing the task pipeline; `/memory` shows the memory run history.
5. **Four run kinds are recorded:** `cold` · `warm` · `skip` · `noop`.
6. **Three run statuses are recorded:** `running` · `complete` · `failed`.
7. **Visibility rule for `memory_runs`:** `WHERE instance = :current OR instance LIKE 'TEST-%'`.
8. **Avoid route conflicts.** The existing per-repo memory status endpoint moves from `/api/memory/:repo` to `/api/memory/status/:repo` before adding `/api/memory/runs...` routes.
9. **Preserve referential integrity for real tasks.** `memory_runs` uses `originTaskId uuid references tasks(id)` for real task-backed runs, and `externalLabel text` for manual test runs.
10. **Memory page should show all visible runs.** No product-level cap is applied on the `/memory` page query; if a safety cap is ever added later, it should come with explicit pagination or load-more UX. The page groups rows by repo from `memory_runs`, then overlays registered-repo status when the repo still exists in `REGISTERED_REPOS`.
11. **Test cleanup is end-to-end.** Clearing test runs removes DB rows, `memory-TEST-*` directories, and transcript artifact directories referenced by deleted rows.
12. **Shared enums stay shared.** `MEMORY_RUN_*` enums live in `src/shared/types.ts` and are re-exported through `dashboard/src/shared.ts`; the dashboard does not hand-duplicate them.
13. **Add indexes up front.** `memory_runs` is an operational log table and should be indexed for repo + recency queries.

---

## Final file layout

```text
src/
  shared/types.ts                         # MODIFIED: MEMORY_RUN_KINDS / STATUSES / SOURCES
  shared/task-kinds.ts                    # MODIFIED: prepend "memory" to every kind
  db/schema.ts                            # MODIFIED: memory run enums, table, indexes
  db/repository.ts                        # MODIFIED: memory run CRUD/list/delete methods
  core/stage.ts                           # MODIFIED: best-effort createTaskStage
  core/memory-cleanup.ts                  # NEW: delete TEST rows + transcript dirs + memory dirs
  pipelines/memory/pipeline.ts            # MODIFIED: persist every run to memory_runs
  api/index.ts                            # MODIFIED: /api/memory/status/:repo + run endpoints + cleanup
  index.ts                                # UNCHANGED BEHAVIOR; serves new route tree via Hono app

drizzle/0005_memory_runs.sql              # NEW: generated additive migration

dashboard/src/
  shared.ts                               # MODIFIED: re-export MEMORY_RUN_* enums/types
  lib/api/types.ts                        # MODIFIED: MemoryRun interface only; enum types from shared
  lib/api/repos.ts                        # MODIFIED: fetchMemoryStatus uses /api/memory/status/:repo
  lib/api/memory.ts                       # NEW: fetchMemoryRuns, fetchMemoryRun, fetchMemoryRunSession, deleteMemoryTests
  lib/api/index.ts                        # MODIFIED: barrel export
  components/PipelineProgress.tsx         # MODIFIED: handle "skipped" status
  components/Layout.tsx                   # MODIFIED: add "Memory" nav item
  components/rows/MemoryRunRow.tsx        # NEW: one run, expandable into a transcript
  pages/Memory.tsx                        # NEW: /memory page showing all visible runs grouped by repo
  App.tsx                                 # MODIFIED: /memory route

tests/scripts/
  clean-memory-tests.ts                   # NEW: CLI cleanup wrapper around core cleanup helper
package.json                              # MODIFIED: test:memory:clean script
```

---

## Task 1: Memory as first pipeline stage + `skipped` status in `PipelineProgress`

**Files:**
- Modify: `src/shared/task-kinds.ts`
- Modify: `dashboard/src/components/PipelineProgress.tsx`

**Implementation:**

In `src/shared/task-kinds.ts`, prepend `"memory"` to every kind's `stages` array:

```ts
export const TASK_KIND_CONFIG: Record<TaskKind, TaskKindConfig> = {
  coding_task: {
    label: "coding task",
    stages: ["memory", "planner", "implementer", "reviewer"],
    artifacts: [ /* unchanged */ ],
  },
  codebase_question: {
    label: "question",
    stages: ["memory", "answering"],
    artifacts: [{ key: "answer.md", label: "answer" }],
  },
  pr_review: {
    label: "PR review",
    stages: ["memory", "pr_reviewing"],
    artifacts: [{ key: "pr-review.md", label: "review" }],
  },
};
```

In `dashboard/src/components/PipelineProgress.tsx`, widen `DisplayStatus` and the style maps to include `"skipped"`:

```ts
type DisplayStatus = "pending" | "active" | "complete" | "failed" | "skipped";

const DOT: Record<DisplayStatus, string> = {
  pending: "bg-text-void",
  active: "bg-accent shadow-[0_0_8px_rgba(212,160,23,0.5)] animate-pulse-soft",
  complete: "bg-ok",
  failed: "bg-fail",
  skipped: "bg-text-void/50",
};

const LABEL: Record<DisplayStatus, string> = {
  pending: "text-text-void",
  active: "text-accent",
  complete: "text-text-dim",
  failed: "text-fail",
  skipped: "text-text-void italic",
};
```

`displayStatus()` can continue returning `stage.status`; the maps now accept `"skipped"`.

**Verify:** `npm run build`. Submit a task; memory dot renders first. If memory is skipped, the first dot is muted grey.

**Commit:** `feat(pipeline): render memory as first pipeline stage with skipped status`

---

## Task 2: Shared `MEMORY_RUN_*` enums and dashboard re-exports

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `dashboard/src/shared.ts`

**Implementation:**

Append new shared enum arrays to `src/shared/types.ts`:

```ts
// --- Memory run kinds ---

export const MEMORY_RUN_KINDS = ["cold", "warm", "skip", "noop"] as const;
export type MemoryRunKind = (typeof MEMORY_RUN_KINDS)[number];

// --- Memory run statuses ---

export const MEMORY_RUN_STATUSES = ["running", "complete", "failed"] as const;
export type MemoryRunStatus = (typeof MEMORY_RUN_STATUSES)[number];

// --- Memory run sources ---

export const MEMORY_RUN_SOURCES = ["task", "manual_test"] as const;
export type MemoryRunSource = (typeof MEMORY_RUN_SOURCES)[number];
```

In `dashboard/src/shared.ts`, re-export the new shared enums and types so dashboard code imports them from `@dashboard/shared` rather than re-declaring unions.

**Verify:** `npm run build`.

**Commit:** `feat(shared): add memory run enums and dashboard re-exports`

---

## Task 3: `memory_runs` table + enums + indexes in Drizzle schema

**Files:**
- Modify: `src/db/schema.ts`

**Implementation:**

Add enums after `prSessionStatusEnum`:

```ts
export const memoryRunKindEnum = pgEnum("memory_run_kind", [
  "cold", "warm", "skip", "noop",
]);
export const memoryRunStatusEnum = pgEnum("memory_run_status", [
  "running", "complete", "failed",
]);
export const memoryRunSourceEnum = pgEnum("memory_run_source", [
  "task", "manual_test",
]);
```

Add the table after `prSessionRuns`:

```ts
export const memoryRuns = pgTable("memory_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  instance: text("instance").notNull(),
  repo: text("repo").notNull(),
  source: memoryRunSourceEnum("source").notNull(),
  kind: memoryRunKindEnum("kind").notNull(),
  status: memoryRunStatusEnum("status").notNull().default("running"),
  originTaskId: uuid("origin_task_id").references(() => tasks.id),
  /** Manual label for runs that do not belong to a tasks row. */
  externalLabel: text("external_label"),
  sha: text("sha"),
  zoneCount: integer("zone_count"),
  error: text("error"),
  /** Absolute path to the pi session JSONL, or null for skip/noop. */
  sessionPath: text("session_path"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  repoStartedAtIdx: index("memory_runs_repo_started_at_idx").on(table.repo, table.startedAt),
  instanceStartedAtIdx: index("memory_runs_instance_started_at_idx").on(table.instance, table.startedAt),
  repoKindStartedAtIdx: index("memory_runs_repo_kind_started_at_idx").on(table.repo, table.kind, table.startedAt),
}));
```

Append to the exports at the bottom:

```ts
export type MemoryRun = typeof memoryRuns.$inferSelect;
```

**Notes:**
- Real tasks use `source = "task"` and `originTaskId`.
- Manual tests use `source = "manual_test"` and `externalLabel`.
- `sessionPath` remains pragmatic storage for same-host transcript reads.

**Verify:** `npm run build`.

**Commit:** `feat(db): memory_runs table, enums, and indexes`

---

## Task 4: Generate and review the migration

**Files:**
- Create: `drizzle/0005_memory_runs.sql`
- Modify: `drizzle/meta/_journal.json`

**Commands:**

```bash
npm run db:generate
# rename the auto-generated file to 0005_memory_runs.sql
# update drizzle/meta/_journal.json to match the renamed tag
```

The SQL should be purely additive:
- `CREATE TYPE memory_run_kind`
- `CREATE TYPE memory_run_status`
- `CREATE TYPE memory_run_source`
- `CREATE TABLE memory_runs`
- index creation statements

Human operator reviews the generated SQL, then applies it from the laptop with:

```bash
npm run db:migrate
```

**Commit:** `feat: drizzle migration for memory_runs`

---

## Task 5: Repository methods for `memory_runs`

**Files:**
- Modify: `src/db/repository.ts`

**Implementation:**

Add memory-run repository methods near the bottom. Import any additional Drizzle helpers needed, including `or`, `like`, and `indexable` predicates.

```ts
import { eq, desc, and, or, like } from "drizzle-orm";
import type {
  MemoryRunKind,
  MemoryRunStatus,
  MemoryRunSource,
} from "../shared/types.js";
import type { MemoryRun } from "./schema.js";
```

Add helpers and methods:

```ts
// --- Memory runs ---

/** Visible-to-dashboard predicate: current instance OR any TEST instance. */
function memoryRunsVisible() {
  return or(
    eq(schema.memoryRuns.instance, loadEnv().INSTANCE_ID),
    like(schema.memoryRuns.instance, "TEST-%"),
  );
}

export async function createMemoryRun(data: {
  instance: string;
  repo: string;
  source: MemoryRunSource;
  kind: MemoryRunKind;
  originTaskId: string | null;
  externalLabel: string | null;
  sessionPath: string | null;
}): Promise<MemoryRun> {
  const db = getDb();
  const [row] = await db.insert(schema.memoryRuns).values({
    ...data,
    status: "running",
  }).returning();
  return row;
}

export async function updateMemoryRun(
  id: string,
  patch: Partial<{
    status: MemoryRunStatus;
    sha: string | null;
    zoneCount: number | null;
    error: string | null;
    completedAt: Date | null;
  }>,
): Promise<MemoryRun | undefined> {
  const db = getDb();
  const [row] = await db.update(schema.memoryRuns)
    .set(patch)
    .where(eq(schema.memoryRuns.id, id))
    .returning();
  return row;
}

export async function listMemoryRuns(opts: {
  repo?: string;
  limit?: number;
  kind?: MemoryRunKind;
  includeTests?: boolean;
} = {}): Promise<MemoryRun[]> {
  const { repo, limit, kind, includeTests = true } = opts;
  const visibility = includeTests
    ? memoryRunsVisible()
    : eq(schema.memoryRuns.instance, loadEnv().INSTANCE_ID);

  const filters = [
    visibility,
    repo ? eq(schema.memoryRuns.repo, repo) : undefined,
    kind ? eq(schema.memoryRuns.kind, kind) : undefined,
  ];

  const db = getDb();
  const query = db.select().from(schema.memoryRuns)
    .where(and(...filters))
    .orderBy(desc(schema.memoryRuns.startedAt));

  return limit === undefined ? query : query.limit(limit);
}

export async function getMemoryRun(id: string): Promise<MemoryRun | undefined> {
  const db = getDb();
  const [row] = await db.select().from(schema.memoryRuns)
    .where(and(eq(schema.memoryRuns.id, id), memoryRunsVisible()))
    .limit(1);
  return row;
}

/**
 * Delete every TEST run and return deleted rows so callers can clean up files.
 */
export async function deleteTestMemoryRuns(): Promise<Array<Pick<MemoryRun, "id" | "sessionPath">>> {
  const db = getDb();
  return db.delete(schema.memoryRuns)
    .where(like(schema.memoryRuns.instance, "TEST-%"))
    .returning({
      id: schema.memoryRuns.id,
      sessionPath: schema.memoryRuns.sessionPath,
    });
}
```

**Verify:** `npm run build`.

**Commit:** `feat(db): memory_runs repository methods`

---

## Task 6: Best-effort `task_stages` writes everywhere memory may run without a task row

**Files:**
- Modify: `src/core/stage.ts`
- Modify: `src/pipelines/memory/pipeline.ts`

**Implementation:**

### In `src/core/stage.ts`

Make `createTaskStage` best-effort so manual test runs do not fail when there is no matching `tasks` row.

```ts
let stageRecord: Awaited<ReturnType<typeof queries.createTaskStage>> | null = null;
try {
  stageRecord = await queries.createTaskStage({ taskId, stage });
} catch (err) {
  log.warn(`createTaskStage failed for task ${taskId} stage ${stage} (no matching tasks row?)`, err);
}
```

Guard all later `updateTaskStage` writes behind `if (stageRecord) { ... }`.

Also make the initial `updateTask(taskId, { status: "running" })` best-effort because manual test runs do not have a `tasks` row.

### In `src/pipelines/memory/pipeline.ts`

Any stage writes outside `runStage()` must also be best-effort:
- noop fast path
- skip path
- helper used by `markSkipped`

Add a small helper:

```ts
async function createBestEffortMemoryStage(taskId: string) {
  return queries.createTaskStage({ taskId, stage: "memory" }).catch(() => null);
}
```

Use it anywhere the memory pipeline writes a `task_stages` row directly.

**Verify:**
- `npm run build`
- run a manual cold test; it should complete instead of failing on FK insertion
- force a skip path and verify it also survives without a `tasks` row

**Commit:** `fix(memory): tolerate non-task-backed stage writes for manual test runs`

---

## Task 7: Persist every memory run to `memory_runs`

**Files:**
- Modify: `src/pipelines/memory/pipeline.ts`

**Implementation:**

Refine `RunMemoryOptions` so the call site states whether a run belongs to a real task or a manual test. Keep `taskId` as the session/artifact key used by existing helpers; add explicit source metadata for DB persistence.

```ts
interface RunMemoryOptions {
  taskId: string;              // real task UUID, or manual test session key
  repo: string;
  repoPath: string;
  source: "task" | "manual_test";
  sendTelegram: SendTelegram;
  chatId: string | null;
}
```

### Call-site rules
- Coding/question pipelines call `runMemory({ ..., source: "task" })`.
- Manual test scripts call `runMemory({ ..., source: "manual_test" })`.

### Memory-run persistence rules
- `cold` / `warm`: insert `status = running` before `runStage()`, finalize with `complete` or `failed`
- `skip`: insert + immediately finalize `complete`
- `noop`: insert + immediately finalize `complete`

### DB identity mapping
- For `source = "task"`: `originTaskId = taskId`, `externalLabel = null`
- For `source = "manual_test"`: `originTaskId = null`, `externalLabel = taskId`

Add a helper that builds the common create payload:

```ts
function memoryRunIdentity(opts: RunMemoryOptions) {
  return opts.source === "task"
    ? { source: "task" as const, originTaskId: opts.taskId, externalLabel: null }
    : { source: "manual_test" as const, originTaskId: null, externalLabel: opts.taskId };
}
```

Use `taskSessionPath(opts.taskId, "memory")` for cold/warm transcript paths, and `null` for skip/noop.

**Important:** Any failure to write `memory_runs` should log a warning but must not bring down the pipeline.

**Verify:**
- `npm run build`
- `npm run test:memory:cold -- v1 <repo>` creates one `manual_test / cold / complete` row
- a real task creates a `task / cold|warm / complete` row with `originTaskId`
- lock contention creates a `skip` row
- up-to-date repo creates a `noop` row

**Commit:** `feat(memory): persist every run to memory_runs`

---

## Task 8: Memory cleanup helper for API + CLI

**Files:**
- Create: `src/core/memory-cleanup.ts`

**Implementation:**

Create a reusable server-side cleanup helper that:
1. deletes all TEST rows via `deleteTestMemoryRuns()`
2. removes parent artifact directories for any returned `sessionPath`
3. removes every `artifacts/memory-TEST-*` directory
4. returns a summary object for API/CLI output

Suggested return shape:

```ts
interface MemoryTestCleanupResult {
  deletedRows: number;
  deletedTranscriptDirs: number;
  deletedMemoryDirs: number;
}
```

This keeps cleanup logic in one place so the dashboard button and CLI script do the same thing.

**Verify:** `npm run build`.

**Commit:** `feat(memory): reusable TEST cleanup helper`

---

## Task 9: API endpoints and route normalization

**Files:**
- Modify: `src/api/index.ts`

**Implementation:**

### Rename the existing status route

Change:

```ts
app.get("/api/memory/:repo", ...)
```

to:

```ts
app.get("/api/memory/status/:repo", ...)
```

This prevents `/api/memory/runs` from being swallowed by the status route.

### Add memory run routes

```ts
import { MEMORY_RUN_KINDS, type MemoryRunKind } from "../shared/types.js";
import { readSessionFile } from "../core/pi/session-file.js";
import { cleanupTestMemoryRuns } from "../core/memory-cleanup.js";

app.get("/api/memory/runs", async (c) => {
  const repo = c.req.query("repo");
  const kindParam = c.req.query("kind");
  const includeTests = c.req.query("includeTests") !== "false";
  const limitParam = c.req.query("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  const kind = MEMORY_RUN_KINDS.includes(kindParam as MemoryRunKind)
    ? (kindParam as MemoryRunKind)
    : undefined;

  const runs = await queries.listMemoryRuns({ repo, kind, includeTests, limit });
  return c.json(runs);
});

app.get("/api/memory/runs/:id", async (c) => {
  const run = await queries.getMemoryRun(c.req.param("id"));
  if (!run) return c.json({ error: "not found" }, 404);
  return c.json(run);
});

app.get("/api/memory/runs/:id/session", async (c) => {
  const run = await queries.getMemoryRun(c.req.param("id"));
  if (!run) return c.json({ error: "not found" }, 404);
  if (!run.sessionPath) return c.json({ entries: [] });
  try {
    const entries = await readSessionFile(run.sessionPath);
    return c.json({ entries });
  } catch (err) {
    log.warn(`Failed to read session ${run.sessionPath}`, err);
    return c.json({ entries: [] });
  }
});

app.delete("/api/memory/tests", async (c) => {
  const result = await cleanupTestMemoryRuns();
  return c.json(result);
});
```

**Verify:**

```bash
curl "http://localhost:${PORT:-3333}/api/memory/status/goodboy" | jq
curl "http://localhost:${PORT:-3333}/api/memory/runs" | jq
curl "http://localhost:${PORT:-3333}/api/memory/runs/<id>/session" | jq
curl -X DELETE "http://localhost:${PORT:-3333}/api/memory/tests" | jq
```

**Commit:** `feat(api): memory run routes, status route rename, and cleanup endpoint`

---

## Task 10: Dashboard wire types + fetchers

**Files:**
- Modify: `dashboard/src/lib/api/types.ts`
- Modify: `dashboard/src/lib/api/repos.ts`
- Create: `dashboard/src/lib/api/memory.ts`
- Modify: `dashboard/src/lib/api/index.ts`

**Implementation:**

In `dashboard/src/lib/api/types.ts`, import memory-run enum types from `@dashboard/shared` and add only the `MemoryRun` interface:

```ts
import type {
  FileEntry,
  TaskKind,
  TaskStatus,
  StageStatus,
  StageName,
  MemoryRunKind,
  MemoryRunStatus,
  MemoryRunSource,
} from "@dashboard/shared";

export interface MemoryRun {
  id: string;
  instance: string;
  repo: string;
  source: MemoryRunSource;
  kind: MemoryRunKind;
  status: MemoryRunStatus;
  originTaskId: string | null;
  externalLabel: string | null;
  sha: string | null;
  zoneCount: number | null;
  error: string | null;
  sessionPath: string | null;
  startedAt: string;
  completedAt: string | null;
}
```

In `dashboard/src/lib/api/repos.ts`, update `fetchMemoryStatus()` to call `/api/memory/status/:repo`.

Create `dashboard/src/lib/api/memory.ts`:

```ts
import { request } from "./client.js";
import type { FileEntry, MemoryRun, MemoryRunKind } from "./types.js";

export interface MemoryRunsQuery {
  repo?: string;
  kind?: MemoryRunKind;
  includeTests?: boolean;
  limit?: number;
}

export async function fetchMemoryRuns(q: MemoryRunsQuery = {}): Promise<MemoryRun[]> {
  const params = new URLSearchParams();
  if (q.repo) params.set("repo", q.repo);
  if (q.kind) params.set("kind", q.kind);
  if (q.includeTests === false) params.set("includeTests", "false");
  if (q.limit) params.set("limit", String(q.limit));
  const qs = params.toString();
  return request(`/api/memory/runs${qs ? `?${qs}` : ""}`);
}

export async function fetchMemoryRun(id: string): Promise<MemoryRun> {
  return request(`/api/memory/runs/${id}`);
}

export async function fetchMemoryRunSession(id: string): Promise<{ entries: FileEntry[] }> {
  return request(`/api/memory/runs/${id}/session`);
}

export async function deleteMemoryTests(): Promise<{
  deletedRows: number;
  deletedTranscriptDirs: number;
  deletedMemoryDirs: number;
}> {
  return request(`/api/memory/tests`, { method: "DELETE" });
}
```

Append to `dashboard/src/lib/api/index.ts`:

```ts
export * from "./memory.js";
```

**Verify:** `npm run build`.

**Commit:** `feat(dashboard): memory run types and fetchers`

---

## Task 11: `MemoryRunRow` component

**Files:**
- Create: `dashboard/src/components/rows/MemoryRunRow.tsx`

**Implementation:**

Build one expandable row per memory run.

Collapsed row shows:
- kind badge
- status
- source (`task` or `manual_test`)
- TEST badge when `instance.startsWith("TEST-")`
- instance string
- sha short hash
- zone count
- relative age + duration
- external label or origin-task hint when relevant
- error summary when present

Expanded row shows:
- `LogViewer` for transcript when `sessionPath` exists
- clear empty-state copy for skip/noop runs with no transcript

Follow dashboard style rules:
- named props interface above component
- `cn()` for conditional classes
- no inline styles

**Verify:** `npm run build`.

**Commit:** `feat(dashboard): MemoryRunRow with expandable transcript`

---

## Task 12: `/memory` page + nav + route

**Files:**
- Create: `dashboard/src/pages/Memory.tsx`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/components/Layout.tsx`

**Implementation:**

### Page data model

The page should show **all visible runs**, not just runs for currently registered repos.

Fetch:
1. `fetchRepos()` for the registered-repo list
2. `fetchMemoryRuns({ includeTests: !hideTests, kind })` for the visible run log
3. `fetchMemoryStatus(repo)` only for repos that are still registered

Group `memory_runs` by repo and render the union of:
- repos present in the run log
- registered repos with zero runs yet

For repos not in `REGISTERED_REPOS`, render the section without memory status and label it as unregistered.

### Refresh behavior

Use a `runsVersion` state number on the page. Increment it after test cleanup so child queries refetch. Do not rely on the repos query alone to refresh run lists.

```tsx
const [runsVersion, setRunsVersion] = useState(0);

async function handleCleanTests() {
  if (!confirm("Delete all TEST memory runs and their local artifacts?")) return;
  setCleaning(true);
  try {
    await deleteMemoryTests();
    setRunsVersion((v) => v + 1);
  } finally {
    setCleaning(false);
  }
}
```

Include `runsVersion` in the dependencies for any query that should refetch after cleanup.

### Route + nav

In `dashboard/src/App.tsx`:

```tsx
import { Memory } from "@dashboard/pages/Memory";

<Route path="/memory" element={<Memory />} />
```

In `dashboard/src/components/Layout.tsx` add:

```ts
{ to: "/memory", label: "Memory" }
```

**Verify:**
- `npm run build`
- `/memory` shows all visible runs grouped across repos
- registered repos with no runs still render a section
- unregistered repos with historical runs still show their run history
- hide-tests toggle works
- clear-tests refreshes the page immediately without manual reload

**Commit:** `feat(dashboard): /memory page with grouped run history and cleanup refresh`

---

## Task 13: `test:memory:clean` CLI wrapper

**Files:**
- Create: `tests/scripts/clean-memory-tests.ts`
- Modify: `package.json`

**Implementation:**

The script should reuse `cleanupTestMemoryRuns()` from `src/core/memory-cleanup.ts` so the CLI and dashboard button behave the same way.

```ts
/** Manual cleanup for memory test runs. */

import "dotenv/config";

const { cleanupTestMemoryRuns } = await import("../../src/core/memory-cleanup.js");

const result = await cleanupTestMemoryRuns();
console.log(`Deleted ${result.deletedRows} TEST memory_runs rows.`);
console.log(`Removed ${result.deletedTranscriptDirs} transcript directories.`);
console.log(`Removed ${result.deletedMemoryDirs} memory-TEST-* directories.`);
```

In `package.json`:

```json
"test:memory:clean": "tsx tests/scripts/clean-memory-tests.ts"
```

**Verify:**

```bash
npm run test:memory:cold -- scratch <repo>
npm run test:memory:clean
```

Expected result:
- TEST rows removed from DB
- transcript artifact dirs removed
- `memory-TEST-*` dirs removed

**Commit:** `feat(tests): test memory cleanup wrapper`

---

## Task 14: Manual test scripts pass explicit source metadata

**Note:** `pr_review` remains stubbed in this plan. Keep the future `runMemory()` hook comment aligned with the new `source: "task"` contract, but do not implement PR review behavior yet.

**Files:**
- Modify: `tests/scripts/run-memory-cold.ts`
- Modify: `tests/scripts/run-memory-warm.ts`
- Modify: `src/pipelines/coding/pipeline.ts`
- Modify: `src/pipelines/question/pipeline.ts`
- Modify: `src/pipelines/pr-review/pipeline.ts` (comment or future hook only; pipeline remains stubbed)

**Implementation:**

Update real pipelines to call:

```ts
await runMemory({
  taskId,
  repo: task.repo,
  repoPath: repo.localPath,
  source: "task",
  sendTelegram,
  chatId,
});
```

Update manual test scripts to call:

```ts
await runMemory({
  taskId: `${testLabel}-cold`,
  repo: repoName,
  repoPath: repo.localPath,
  source: "manual_test",
  sendTelegram: noopTelegram,
  chatId: null,
});
```

This removes implicit UUID guessing and makes the persistence rules explicit.

**Verify:** `npm run build`.

**Commit:** `refactor(memory): make run source explicit at call sites`

---

## Task 15: End-to-end verification

1. Trigger a real task against a repo with no memory state. `/memory` shows one `task / cold / complete` run.
2. Trigger a second task immediately. `/memory` shows a `task / skip / complete` run.
3. Trigger a task against an up-to-date repo. `/memory` shows a `task / noop / complete` run.
4. Make a commit in the repo and trigger another task. `/memory` shows a `task / warm / complete` run.
5. Run `npm run test:memory:cold -- v1 <repo>`. `/memory` shows a `manual_test / cold / complete` run with a `TEST` badge and visible `TEST-<hex>` instance.
6. Expand a cold or warm run. Transcript loads from the stored session file.
7. Click `clear tests` on `/memory` or run `npm run test:memory:clean`. DB rows, transcript dirs, and `memory-TEST-*` dirs are all removed.
8. Memory dot appears first on task detail pages. If memory skipped, the first dot is muted grey.
9. `/api/memory/status/:repo` still returns the expected per-repo status payload.
10. `/api/memory/runs` does not conflict with the status route.

**Commit:** verification only; any fixes use `fix:`.

---

## Post-plan checklist

- [ ] Shared `MEMORY_RUN_*` enums added once in `src/shared/types.ts` and re-exported through `dashboard/src/shared.ts`
- [ ] `memory` appears first in every task kind's stage list
- [ ] `PipelineProgress` supports `skipped`
- [ ] `memory_runs` table created with `originTaskId`, `externalLabel`, and indexes
- [ ] Migration reviewed and applied from laptop with `npm run db:migrate`
- [ ] `runStage()` and all direct memory stage writes are best-effort for non-task-backed runs
- [ ] Cold / warm / skip / noop each create a visible `memory_runs` row
- [ ] `/api/memory/status/:repo` replaces `/api/memory/:repo`
- [ ] `/api/memory/runs` lists visible runs without route conflicts
- [ ] `/memory` page shows all visible runs grouped by repo, including unregistered historical repos, with no product-level cap
- [ ] Dashboard clear-tests action removes DB rows and on-disk TEST artifacts end-to-end
- [ ] `npm run test:memory:clean` reuses the same cleanup helper as the API
- [ ] `npm run build` clean
- [ ] `npm test` clean
