# Memory Runs Table + Dedicated `/memory` Dashboard Page Implementation Plan

**Goal:** Surface every memory run (cold, warm, skip, noop) — including runs triggered by the manual test runners — as first-class entities on a new `/memory` dashboard page, and render the existing `memory` stage as the first dot in every task's pipeline.

**Approach:** Introduce a `memory_runs` table owning each run's kind / status / sha / session-file path. The memory pipeline writes a row on every branch; test-runner runs (which never create a `tasks` row) survive a now-best-effort `task_stages` insert inside `runStage`. The prod dashboard filter is relaxed for `memory_runs` only: `WHERE instance = :current OR instance LIKE 'TEST-%'`, which naturally surfaces test runs without adding an `isTest` / `env` column. Test runs are identified solely by `instance LIKE 'TEST-%'` (the convention already established in `tests/scripts/run-memory-cold.ts`) and carry the `instance` string as a visible tag in the UI.

**Stack:** TypeScript · Drizzle · Hono · React + react-router · existing pi session log viewer.

---

## Locked design decisions

1. **No new enum for environment.** `INSTANCE_ID` (stored in every table's `instance` column) already encodes identity. `TEST-<hex>` prefix defines test runs.
2. **No stub `tasks` rows for test runs.** Test runs live only in `memory_runs`. They never appear in the Tasks list or PipelineProgress.
3. **`runStage` becomes best-effort on `createTaskStage`.** When there's no matching `tasks` row (test runners), the FK insert fails; we catch, warn, and continue with `stageRecord = null`. All follow-up `updateTaskStage` calls guard on null.
4. **Memory page is the exclusive view for test runs.** They won't show in `TaskDetail`.
5. **Four run kinds recorded:** `cold` · `warm` · `skip` (lock held) · `noop` (up-to-date fast path). All four surface on the Memory page with a visible badge.
6. **Instance filter rule for `memory_runs`:** `WHERE instance = :current OR instance LIKE 'TEST-%'`. Writes are not filtered — every row carries its own `instance`.

---

## Final file layout

```
src/
  shared/types.ts                         # MODIFIED: MEMORY_RUN_KINDS, MEMORY_RUN_STATUSES
  shared/task-kinds.ts                    # MODIFIED: prepend "memory" to every kind
  db/schema.ts                            # MODIFIED: memory_run_kind + memory_run_status enums, memory_runs table
  db/repository.ts                        # MODIFIED: createMemoryRun, updateMemoryRun, list*, deleteTestMemoryRuns
  core/stage.ts                           # MODIFIED: best-effort createTaskStage
  pipelines/memory/pipeline.ts            # MODIFIED: persist every run to memory_runs
  api/index.ts                            # MODIFIED: GET/DELETE memory run endpoints + session endpoint
drizzle/0005_memory_runs.sql              # NEW: generated
dashboard/src/
  lib/api/types.ts                        # MODIFIED: MemoryRun, MemoryRunKind, MemoryRunStatus
  lib/api/memory.ts                       # NEW: fetchMemoryRuns, fetchMemoryRun, fetchMemoryRunSession, deleteMemoryTests
  lib/api/index.ts                        # MODIFIED: barrel export
  components/PipelineProgress.tsx         # MODIFIED: handle "skipped" status
  components/Layout.tsx                   # MODIFIED: add "Memory" nav item
  components/rows/MemoryRunRow.tsx        # NEW: one run, expandable into a transcript
  pages/Memory.tsx                        # NEW: /memory page
  App.tsx                                 # MODIFIED: /memory route
tests/scripts/
  clean-memory-tests.ts                   # NEW: CLI cleanup
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

In `dashboard/src/components/PipelineProgress.tsx`, widen `DisplayStatus` and the two maps to include `"skipped"`, and update `displayStatus`:

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

`displayStatus` is already correct — `return stage.status` will now safely return `"skipped"` since the maps accept it.

**Verify:** `npm run build`. Submit a task; memory dot renders first; if memory is skipped (lock held), the dot is muted grey.

**Commit:** `feat(pipeline): render memory as first pipeline stage with skipped status`

---

## Task 2: `MEMORY_RUN_KINDS` / `MEMORY_RUN_STATUSES` in `shared/types.ts`

**Files:**
- Modify: `src/shared/types.ts`

**Implementation:**

Append two new enum arrays to the existing `// --- Task kinds ---` / `// --- Task statuses ---` style:

```ts
// --- Memory run kinds ---

export const MEMORY_RUN_KINDS = ["cold", "warm", "skip", "noop"] as const;
export type MemoryRunKind = (typeof MEMORY_RUN_KINDS)[number];

// --- Memory run statuses ---

export const MEMORY_RUN_STATUSES = ["running", "complete", "failed"] as const;
export type MemoryRunStatus = (typeof MEMORY_RUN_STATUSES)[number];
```

**Verify:** `npm run build`.

**Commit:** `feat(shared): memory run kinds and statuses`

---

## Task 3: `memory_runs` table + enums in Drizzle schema

**Files:**
- Modify: `src/db/schema.ts`

**Implementation:**

After `prSessionStatusEnum`, add:

```ts
export const memoryRunKindEnum = pgEnum("memory_run_kind", [
  "cold", "warm", "skip", "noop",
]);
export const memoryRunStatusEnum = pgEnum("memory_run_status", [
  "running", "complete", "failed",
]);
```

After `prSessionRuns`, add the table:

```ts
export const memoryRuns = pgTable("memory_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  instance: text("instance").notNull(),
  repo: text("repo").notNull(),
  kind: memoryRunKindEnum("kind").notNull(),
  status: memoryRunStatusEnum("status").notNull().default("running"),
  /** Canonical task id (uuid string) or test label (e.g. "my-test-cold"). Not an FK. */
  taskId: text("task_id"),
  sha: text("sha"),
  zoneCount: integer("zone_count"),
  error: text("error"),
  /** Absolute path to the pi session JSONL, or null for skip/noop (no pi spawn). */
  sessionPath: text("session_path"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});
```

Append to the exports at the bottom of the file:

```ts
export type MemoryRun = typeof memoryRuns.$inferSelect;
```

**Verify:** `npm run build`.

**Commit:** `feat(db): memory_runs table and enums`

---

## Task 4: Generate + rename the Drizzle migration

**Files:**
- Create: `drizzle/0005_memory_runs.sql`

**Commands:**

```bash
npm run db:generate
# rename the auto-generated file to 0005_memory_runs.sql
# update drizzle/meta/_journal.json to match the renamed tag
```

The resulting SQL should be purely additive: two `CREATE TYPE` statements + one `CREATE TABLE`. Human operator applies from laptop with `npm run db:migrate` **after review** of the generated file, **before** Task 5 merges.

**Commit:** `feat: drizzle migration for memory_runs`

---

## Task 5: Repository methods for `memory_runs`

**Files:**
- Modify: `src/db/repository.ts`

**Implementation:**

Add a new section at the bottom of the file with four methods. The list methods use the special filter `instance = :current OR instance LIKE 'TEST-%'`.

```ts
// --- Memory runs ---

import { sql, desc, and, or, eq, like } from "drizzle-orm";
import type { MemoryRunKind, MemoryRunStatus } from "../shared/types.js";

export async function createMemoryRun(data: {
  instance: string;
  repo: string;
  kind: MemoryRunKind;
  taskId: string | null;
  sessionPath: string | null;
}): Promise<schema.MemoryRun> {
  const db = getDb();
  const [row] = await db.insert(schema.memoryRuns).values({
    ...data, status: "running",
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
): Promise<schema.MemoryRun | undefined> {
  const db = getDb();
  const [row] = await db.update(schema.memoryRuns)
    .set(patch).where(eq(schema.memoryRuns.id, id)).returning();
  return row;
}

/** Visible-to-dashboard predicate: this instance OR any test instance. */
function memoryRunsVisible() {
  return or(
    eq(schema.memoryRuns.instance, loadEnv().INSTANCE_ID),
    like(schema.memoryRuns.instance, "TEST-%"),
  );
}

export async function listMemoryRunsForRepo(
  repo: string,
  opts: { limit?: number; kind?: MemoryRunKind; includeTests?: boolean } = {},
): Promise<schema.MemoryRun[]> {
  const { limit = 50, kind, includeTests = true } = opts;
  const db = getDb();
  const filters = [
    eq(schema.memoryRuns.repo, repo),
    includeTests
      ? memoryRunsVisible()
      : eq(schema.memoryRuns.instance, loadEnv().INSTANCE_ID),
  ];
  if (kind) filters.push(eq(schema.memoryRuns.kind, kind));
  return db.select().from(schema.memoryRuns)
    .where(and(...filters))
    .orderBy(desc(schema.memoryRuns.startedAt))
    .limit(limit);
}

export async function getMemoryRun(id: string): Promise<schema.MemoryRun | undefined> {
  const db = getDb();
  const [row] = await db.select().from(schema.memoryRuns)
    .where(and(eq(schema.memoryRuns.id, id), memoryRunsVisible())).limit(1);
  return row;
}

/** Delete every run whose instance begins with `TEST-`. Returns the count. */
export async function deleteTestMemoryRuns(): Promise<number> {
  const db = getDb();
  const deleted = await db.delete(schema.memoryRuns)
    .where(like(schema.memoryRuns.instance, "TEST-%"))
    .returning({ id: schema.memoryRuns.id });
  return deleted.length;
}
```

`loadEnv` is already imported at the top of `repository.ts` — if not, add it from `../shared/config.js`.

**Verify:** `npm run build`.

**Commit:** `feat(db): memory_runs repository methods`

---

## Task 6: Best-effort `createTaskStage` in `runStage`

**Files:**
- Modify: `src/core/stage.ts`

**Implementation:**

Change the success path so a failing `createTaskStage` (FK violation for test-run taskIds) no longer kills the stage. `stageRecord` becomes `TaskStage | null`; every subsequent write guards on null.

```ts
// inside runStage, inside withStageSpan:

await queries.updateTask(taskId, { status: "running" }).catch(() => {});
emit({ type: "task_update", taskId, status: "running" });

let stageRecord: Awaited<ReturnType<typeof queries.createTaskStage>> | null = null;
try {
  stageRecord = await queries.createTaskStage({ taskId, stage });
} catch (err) {
  log.warn(`createTaskStage failed for task ${taskId} stage ${stage} (no matching tasks row?)`, err);
}

emit({ type: "stage_update", taskId, stage, status: "running" });
// ... rest unchanged until the status writes:

if (options.postValidate) {
  const result = await options.postValidate();
  if (!result.valid) {
    const reason = result.reason ?? "postValidate failed";
    if (stageRecord) {
      await queries.updateTaskStage(stageRecord.id, {
        status: "failed", completedAt: new Date(), error: reason,
      }).catch(() => {});
    }
    emit({ type: "stage_update", taskId, stage, status: "failed" });
    log.warn(`Stage ${stage} failed postValidate for task ${taskId}: ${reason}`);
    return;
  }
}

if (stageRecord) {
  await queries.updateTaskStage(stageRecord.id, { status: "complete", completedAt: new Date() });
}
emit({ type: "stage_update", taskId, stage, status: "complete" });
await notifyTelegram(sendTelegram, chatId, `Stage complete: ${stageLabel}.`);
log.info(`Stage ${stage} complete for task ${taskId}`);

// and in the catch branch, the existing updateTaskStage also needs the guard:
} catch (err) {
  if (stageRecord) {
    await queries.updateTaskStage(stageRecord.id, { status: "failed" }).catch(() => {});
  }
  emit({ type: "stage_update", taskId, stage, status: "failed" });
  throw err;
}
```

**Verify:** `npm run build`. Manual: trigger a memory run via the test runners (Task 9's pre-existing `run-memory-cold.ts`) — the pi session must complete instead of crashing on FK. The warning should appear once in stdout.

**Commit:** `fix(core/stage): tolerate missing task rows so test-runner memory runs survive`

---

## Task 7: Persist every memory run to `memory_runs`

**Files:**
- Modify: `src/pipelines/memory/pipeline.ts`

**Implementation:**

Every branch of `runMemory` writes one row. Skip and noop write a single `complete` row directly (no pi spawn). Cold and warm insert a `running` row before `runStage`, then update after.

Add imports:

```ts
import * as queries from "../../db/repository.js";
import { taskSessionPath } from "../../core/pi/session-file.js";
// loadEnv already imported
```

(`queries` is already imported — reuse.)

In `runMemory`, after `tryAcquireLock` fails:

```ts
if (!acquired) {
  await recordSkip(taskId, repo);
  await markSkipped(taskId, repo);
  return;
}
```

In the noop branch (after `changed.length === 0`):

```ts
if (changed.length === 0) {
  log.info(`Memory up-to-date for ${repo} @ ${headSha.slice(0, 8)}`);
  await writeState(repo, headSha, state.zones);
  await recordNoop(taskId, repo, headSha, state.zones.length);
  // existing stage-row creation stays — it succeeds when taskId is a real task uuid.
  const stage = await queries.createTaskStage({ taskId, stage: "memory" }).catch(() => null);
  if (stage) await queries.updateTaskStage(stage.id, { status: "complete", completedAt: new Date() });
  emit({ type: "stage_update", taskId, stage: "memory", status: "complete" });
  return;
}
```

Refactor `runCold` and `runWarm` to wrap their `runStage` calls with a `memory_runs` row:

```ts
async function runCold(opts, worktree, headSha) {
  const run = await queries.createMemoryRun({
    instance: loadEnv().INSTANCE_ID,
    repo: opts.repo,
    kind: "cold",
    taskId: opts.taskId,
    sessionPath: taskSessionPath(opts.taskId, "memory"),
  });

  let validatedZones: readonly Zone[] | null = null;
  let runFailed: string | null = null;

  try {
    const cap = subagentCapability();
    const manifest = await buildFileManifest(worktree);

    await runStage({
      // ... existing options unchanged ...
      postValidate: async () => {
        const zones = await readZonesSidecar(opts.repo);
        if (zones === null) { runFailed = ".zones.json missing or invalid"; return { valid: false, reason: runFailed }; }
        const fileCheck = memoryFilesValid(opts.repo, zones);
        if (!fileCheck.valid) { runFailed = fileCheck.reason ?? "invalid memory files"; return { valid: false, reason: runFailed }; }
        const clean = await assertMemoryWorktreeClean(opts.repo);
        if (!clean.clean) {
          runFailed = `memory worktree dirty after cold: ${clean.dirty.slice(0, 5).join(", ")}`;
          return { valid: false, reason: runFailed };
        }
        validatedZones = zones;
        return { valid: true };
      },
    });
  } catch (err) {
    runFailed = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    if (validatedZones) {
      await writeState(opts.repo, headSha, validatedZones);
      await queries.updateMemoryRun(run.id, {
        status: "complete", sha: headSha, zoneCount: validatedZones.length,
        completedAt: new Date(),
      });
    } else {
      await queries.updateMemoryRun(run.id, {
        status: "failed", error: runFailed ?? "unknown cold failure",
        completedAt: new Date(),
      });
    }
  }
}
```

Mirror the change in `runWarm`: create a `memory_runs` row with `kind: "warm"`, finalize with `status: "complete"` + `sha: headSha` + `zoneCount: state.zones.length` when `structurallyValid`, else `status: "failed"` with the captured reason.

Add two helpers near the bottom:

```ts
async function recordSkip(taskId: string, repo: string): Promise<void> {
  await queries.createMemoryRun({
    instance: loadEnv().INSTANCE_ID, repo, kind: "skip",
    taskId, sessionPath: null,
  }).then((run) => queries.updateMemoryRun(run.id, {
    status: "complete", completedAt: new Date(),
  })).catch((err) => log.warn(`Failed to record skip memory_run for ${repo}`, err));
}

async function recordNoop(
  taskId: string, repo: string, sha: string, zoneCount: number,
): Promise<void> {
  await queries.createMemoryRun({
    instance: loadEnv().INSTANCE_ID, repo, kind: "noop",
    taskId, sessionPath: null,
  }).then((run) => queries.updateMemoryRun(run.id, {
    status: "complete", sha, zoneCount, completedAt: new Date(),
  })).catch((err) => log.warn(`Failed to record noop memory_run for ${repo}`, err));
}
```

**Verify:**
- `npm run build`.
- `npm run test:memory:cold -- v1 <repo>`: one `cold` row appears in `memory_runs` with `status=complete`, non-null `sha` + `zoneCount` + `sessionPath`.
- Submit two real tasks back-to-back: first records `cold` (or `warm`), second records `skip` (lock held).
- Submit a task against an up-to-date repo: one `noop` row.

**Commit:** `feat(pipelines/memory): persist every run to memory_runs (cold/warm/skip/noop)`

---

## Task 8: API endpoints

**Files:**
- Modify: `src/api/index.ts`

**Implementation:**

Add under a new `// --- Memory runs ---` section, after the existing memory block:

```ts
import {
  readSessionFile,    // already imported for tasks
} from "../core/pi/session-file.js";
import { MEMORY_RUN_KINDS, type MemoryRunKind } from "../shared/types.js";

app.get("/api/memory/runs", async (c) => {
  const repo = c.req.query("repo");
  const kindParam = c.req.query("kind");
  const includeTests = c.req.query("includeTests") !== "false";
  const limit = Number(c.req.query("limit") ?? 50);
  if (!repo) return c.json({ error: "repo query param required" }, 400);
  const kind = MEMORY_RUN_KINDS.includes(kindParam as MemoryRunKind)
    ? (kindParam as MemoryRunKind)
    : undefined;
  const runs = await queries.listMemoryRunsForRepo(repo, { kind, includeTests, limit });
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
  const count = await queries.deleteTestMemoryRuns();
  return c.json({ deleted: count });
});
```

**Verify:**
```bash
curl 'http://localhost:3000/api/memory/runs?repo=goodboy' | jq
curl 'http://localhost:3000/api/memory/runs/<id>/session' | jq
curl -X DELETE http://localhost:3000/api/memory/tests
```

**Commit:** `feat(api): memory run listing, detail, transcript, and test cleanup`

---

## Task 9: Dashboard wire types + fetchers

**Files:**
- Modify: `dashboard/src/lib/api/types.ts`
- Create: `dashboard/src/lib/api/memory.ts`
- Modify: `dashboard/src/lib/api/index.ts`

**Implementation:**

In `types.ts`, after the `// --- Memory ---` section, add:

```ts
export type MemoryRunKind = "cold" | "warm" | "skip" | "noop";
export type MemoryRunStatus = "running" | "complete" | "failed";

export interface MemoryRun {
  id: string;
  instance: string;
  repo: string;
  kind: MemoryRunKind;
  status: MemoryRunStatus;
  taskId: string | null;
  sha: string | null;
  zoneCount: number | null;
  error: string | null;
  sessionPath: string | null;
  startedAt: string;
  completedAt: string | null;
}
```

Create `memory.ts`:

```ts
/** Memory run listing, transcript, and test cleanup. */

import { request } from "./client.js";
import type { MemoryRun, MemoryRunKind, FileEntry } from "./types.js";

export interface MemoryRunsQuery {
  repo: string;
  kind?: MemoryRunKind;
  includeTests?: boolean;
  limit?: number;
}

export async function fetchMemoryRuns(q: MemoryRunsQuery): Promise<MemoryRun[]> {
  const params = new URLSearchParams({ repo: q.repo });
  if (q.kind) params.set("kind", q.kind);
  if (q.includeTests === false) params.set("includeTests", "false");
  if (q.limit) params.set("limit", String(q.limit));
  return request(`/api/memory/runs?${params.toString()}`);
}

export async function fetchMemoryRun(id: string): Promise<MemoryRun> {
  return request(`/api/memory/runs/${id}`);
}

export async function fetchMemoryRunSession(id: string): Promise<{ entries: FileEntry[] }> {
  return request(`/api/memory/runs/${id}/session`);
}

export async function deleteMemoryTests(): Promise<{ deleted: number }> {
  return request(`/api/memory/tests`, { method: "DELETE" });
}
```

Append to `index.ts`:

```ts
export * from "./memory.js";
```

**Verify:** `npm run build`.

**Commit:** `feat(dashboard): memory run wire types and fetchers`

---

## Task 10: `MemoryRunRow` component

**Files:**
- Create: `dashboard/src/components/rows/MemoryRunRow.tsx`

**Implementation:**

One expandable row. Collapsed: kind badge, status, instance tag, sha, relative age, zone count. Expanded: `LogViewer` with the run's session entries.

```tsx
/** One memory_runs row. Click to expand into the pi session transcript. */

import { useState } from "react";
import { fetchMemoryRunSession } from "@dashboard/lib/api";
import type { MemoryRun, MemoryRunKind, MemoryRunStatus, FileEntry } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { timeAgo, formatDuration } from "@dashboard/lib/format";
import { cn } from "@dashboard/lib/utils";
import { LogViewer } from "@dashboard/components/log-viewer";

const KIND_TONE: Record<MemoryRunKind, string> = {
  cold: "text-accent",
  warm: "text-ok",
  skip: "text-text-void",
  noop: "text-text-dim",
};

const STATUS_TONE: Record<MemoryRunStatus, string> = {
  running: "text-accent",
  complete: "text-ok",
  failed: "text-fail",
};

export function MemoryRunRow({ run }: { run: MemoryRun }) {
  const [open, setOpen] = useState(false);
  const isTest = run.instance.startsWith("TEST-");

  return (
    <div className="rounded-lg bg-glass px-3 py-2 font-mono text-[10px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className={cn("uppercase tracking-wider", KIND_TONE[run.kind])}>{run.kind}</span>
        <span className={STATUS_TONE[run.status]}>{run.status}</span>
        {isTest && <span className="rounded bg-fail/20 px-1 text-fail">TEST</span>}
        <span className="text-text-ghost">{run.instance}</span>
        {run.sha && <span className="text-text-void">{run.sha.slice(0, 8)}</span>}
        {run.zoneCount !== null && (
          <span className="text-text-void">
            {run.zoneCount} zone{run.zoneCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="text-text-ghost">{timeAgo(run.startedAt)}</span>
        {run.completedAt && (
          <span className="text-text-void">{formatDuration(run.startedAt, run.completedAt)}</span>
        )}
        {run.error && <span className="ml-auto truncate text-fail">{run.error}</span>}
      </button>
      {open && <RunTranscript runId={run.id} hasSession={!!run.sessionPath} />}
    </div>
  );
}

function RunTranscript({ runId, hasSession }: { runId: string; hasSession: boolean }) {
  const { data, loading, error } = useQuery(() => fetchMemoryRunSession(runId), [runId]);
  if (!hasSession) return <p className="mt-2 text-text-ghost">No transcript (skip / noop did not spawn pi).</p>;
  if (loading) return <p className="mt-2 text-text-ghost">Loading transcript...</p>;
  if (error) return <p className="mt-2 text-fail">{error}</p>;
  const entries: FileEntry[] = data?.entries ?? [];
  if (entries.length === 0) return <p className="mt-2 text-text-ghost">Transcript is empty.</p>;
  return <div className="mt-2"><LogViewer entries={entries} /></div>;
}
```

**Verify:** `npm run build`.

**Commit:** `feat(dashboard): MemoryRunRow with expandable transcript`

---

## Task 11: `/memory` page + nav + route

**Files:**
- Create: `dashboard/src/pages/Memory.tsx`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/components/Layout.tsx`

**Implementation:**

`Memory.tsx`:

```tsx
/** Memory page: per-repo memory state + recent-runs log. */

import { useMemo, useState } from "react";
import {
  fetchRepos, fetchMemoryStatus, fetchMemoryRuns, deleteMemoryTests,
} from "@dashboard/lib/api";
import type { Repo, MemoryRun, MemoryRunKind } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { PageState } from "@dashboard/components/PageState";
import { EmptyState } from "@dashboard/components/EmptyState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { MemoryRunRow } from "@dashboard/components/rows/MemoryRunRow";
import { cn } from "@dashboard/lib/utils";

export function Memory() {
  const { data: repos, loading, error, refetch } = useQuery(() => fetchRepos());
  const [kindFilter, setKindFilter] = useState<MemoryRunKind | "all">("all");
  const [hideTests, setHideTests] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  async function handleCleanTests() {
    if (!confirm("Delete all TEST- memory runs from the database?")) return;
    setCleaning(true);
    try { await deleteMemoryTests(); refetch(); }
    finally { setCleaning(false); }
  }

  return (
    <div>
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight text-text">Memory</h1>
          <p className="mt-1 font-mono text-[11px] text-text-ghost">
            per-repo agent memory + run history
          </p>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px]">
          <KindFilter value={kindFilter} onChange={setKindFilter} />
          <label className="flex items-center gap-1 text-text-ghost">
            <input type="checkbox" checked={hideTests} onChange={(e) => setHideTests(e.target.checked)} />
            hide tests
          </label>
          <button
            type="button"
            onClick={handleCleanTests}
            disabled={cleaning}
            className="rounded bg-fail/15 px-2 py-0.5 text-fail hover:bg-fail/25 disabled:opacity-40"
          >
            clear tests
          </button>
        </div>
      </header>

      <PageState
        data={repos}
        loading={loading}
        error={error}
        onRetry={refetch}
        isEmpty={(r) => r.length === 0}
        empty={<EmptyState title="No repos registered" description="Add repos to REGISTERED_REPOS" />}
      >
        {(repos) => (
          <div className="space-y-10">
            {repos.map((repo) => (
              <RepoMemorySection
                key={repo.name}
                repo={repo}
                kindFilter={kindFilter}
                hideTests={hideTests}
              />
            ))}
          </div>
        )}
      </PageState>
    </div>
  );
}

// --- Per-repo section ---

function RepoMemorySection({
  repo, kindFilter, hideTests,
}: {
  repo: Repo;
  kindFilter: MemoryRunKind | "all";
  hideTests: boolean;
}) {
  const { data: status } = useQuery(() => fetchMemoryStatus(repo.name), [repo.name]);
  const { data: runs } = useQuery(
    () => fetchMemoryRuns({
      repo: repo.name,
      kind: kindFilter === "all" ? undefined : kindFilter,
      includeTests: !hideTests,
      limit: 100,
    }),
    [repo.name, kindFilter, hideTests],
  );

  const filteredRuns = useMemo<MemoryRun[]>(() => runs ?? [], [runs]);

  return (
    <section>
      <SectionDivider label={repo.name} detail={status ? status.status : "..."} />
      <div className="mt-3 space-y-1.5">
        {filteredRuns.length === 0 ? (
          <p className="font-mono text-[10px] text-text-ghost">No runs yet.</p>
        ) : (
          filteredRuns.map((run) => <MemoryRunRow key={run.id} run={run} />)
        )}
      </div>
    </section>
  );
}

// --- Kind filter ---

const KINDS: readonly (MemoryRunKind | "all")[] = ["all", "cold", "warm", "skip", "noop"];

function KindFilter({
  value, onChange,
}: { value: MemoryRunKind | "all"; onChange: (v: MemoryRunKind | "all") => void }) {
  return (
    <div className="flex items-center gap-1">
      {KINDS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={cn(
            "rounded px-1.5 py-0.5",
            value === k ? "bg-accent/20 text-accent" : "text-text-ghost hover:text-text-dim",
          )}
        >
          {k}
        </button>
      ))}
    </div>
  );
}
```

In `App.tsx`, add the route and import:

```tsx
import { Memory } from "@dashboard/pages/Memory";

// inside <Routes>:
<Route path="/memory" element={<Memory />} />
```

In `Layout.tsx`, add one entry to `NAV_ITEMS`:

```ts
const NAV_ITEMS = [
  { to: "/", label: "Tasks" },
  { to: "/prs", label: "PRs" },
  { to: "/repos", label: "Repos" },
  { to: "/memory", label: "Memory" },
] as const;
```

**Verify:**
- `npm run build`.
- `npm run dev`, navigate to `/memory`. Each registered repo has a section. Kind filter chips work. Hide-tests toggle works. Clicking a run expands the transcript. "clear tests" button deletes test rows.

**Commit:** `feat(dashboard): /memory page with run history, kind filter, transcript, and test cleanup`

---

## Task 12: `test:memory:clean` CLI script

**Files:**
- Create: `tests/scripts/clean-memory-tests.ts`
- Modify: `package.json`

**Implementation:**

```ts
/**
 * Manual cleanup for memory test runs. Deletes every memory_runs row with
 * instance matching TEST-%, and removes every artifacts/memory-TEST-*
 * directory on disk.
 *
 * Usage: npm run test:memory:clean
 */

import "dotenv/config";
import { rm, readdir } from "node:fs/promises";
import path from "node:path";

const { config } = await import("../../src/shared/config.js");
const { deleteTestMemoryRuns } = await import("../../src/db/repository.js");

const deleted = await deleteTestMemoryRuns();
console.log(`Deleted ${deleted} memory_runs rows (instance LIKE 'TEST-%').`);

let wiped = 0;
try {
  const entries = await readdir(config.artifactsDir);
  for (const e of entries) {
    if (!e.startsWith("memory-TEST-")) continue;
    await rm(path.join(config.artifactsDir, e), { recursive: true, force: true });
    wiped += 1;
  }
} catch (err) {
  console.warn("Failed to scan artifactsDir:", err);
}
console.log(`Removed ${wiped} artifacts/memory-TEST-* directories.`);
```

In `package.json`:

```json
"test:memory:clean": "tsx tests/scripts/clean-memory-tests.ts"
```

**Verify:**
```bash
npm run test:memory:cold -- scratch <repo>   # produces one TEST- row + dir
npm run test:memory:clean                     # should report 1 deleted, 1 wiped
```

**Commit:** `feat(tests): test:memory:clean script removes TEST rows and dirs`

---

## Task 13: E2E verification

1. Trigger a real task against a repo with cold memory. Dashboard `/memory` shows one `cold complete` run.
2. Trigger a second task immediately. `/memory` shows a `skip complete` row.
3. After a trivial commit, trigger another task. Page shows `warm complete`.
4. `npm run test:memory:cold -- v1 <repo>`; `/memory` shows a new `cold complete` with `TEST` badge and `TEST-<hex>` instance tag. `hide tests` toggle removes it.
5. `curl -X DELETE /api/memory/tests`. `/memory` loses the TEST row.
6. Memory dot is the first stage on `/tasks/:id`; if skipped, the dot is muted grey.

**Commit:** verification only; fix-forwards use `fix:`.

---

## Post-plan checklist

- [ ] Task 4 migration applied from laptop (`npm run db:migrate`) before Task 5 merges
- [ ] `npm run build` clean
- [ ] `/memory` renders for every registered repo
- [ ] Cold / warm / skip / noop rows all appear with correct kind badge
- [ ] Test runs visible with `TEST` badge + `TEST-<hex>` instance tag; `hide tests` hides them
- [ ] "clear tests" button deletes test rows end-to-end
- [ ] `npm run test:memory:clean` deletes DB rows + disk dirs
- [ ] Memory dot appears first in `PipelineProgress` across all three kinds
- [ ] `skipped` status renders without crashing
