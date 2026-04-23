# Memory Complete Delete Implementation Plan

**Goal:** Add a repo-scoped “complete delete” flow that removes the current memory store for a repository, removes its nested memory worktree, and marks that repo’s historical memory runs inactive in the database.
**Approach:** Add a repo-level delete API that acquires the existing memory lock, removes the tracked git worktree cleanly, deletes the entire `artifacts/memory-<INSTANCE_ID>-<repo>/` directory, and updates `memory_runs.active` from `TRUE` to `FALSE` for that repo. Then wire a dashboard action on the Memory page so operators can trigger the delete with confirmation and immediately see the repo return to `missing` and the deleted runs disappear from normal history.
**Stack:** Hono API, Drizzle/Postgres, Node fs/git worktree helpers, Vite React dashboard

---

Assumption: follow your requested schema literally with an `active` enum column whose values are `TRUE` and `FALSE`. I would normally prefer `ACTIVE` / `DELETED` or a boolean, but this plan uses your requested shape.

### Task 1: Add the database state for active vs deleted memory runs

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/repository.ts`
- Create: `drizzle/<generated migration>.sql`
- Modify: `dashboard/src/lib/api/types.ts`

**Implementation:**
1. In `src/db/schema.ts`, add a new enum and column on `memory_runs`:

```ts
export const memoryRunActiveEnum = pgEnum("memory_run_active", [
  "TRUE",
  "FALSE",
]);
```

Then add the column to `memoryRuns`:

```ts
active: memoryRunActiveEnum("active").notNull().default("TRUE"),
```

2. While touching indexes, add one index that matches the new read pattern for normal UI history:

```ts
repoActiveStartedAtIdx: index("memory_runs_repo_active_started_at_idx")
  .on(table.repo, table.active, table.startedAt),
```

3. In `src/db/repository.ts`, change the memory run visibility helpers so normal reads only return active rows.
   - Replace the current `memoryRunsVisible()` helper with something like:

```ts
function memoryRunsVisible(includeInactive = false) {
  const instanceVisible = or(
    eq(schema.memoryRuns.instance, loadEnv().INSTANCE_ID),
    like(schema.memoryRuns.instance, "TEST-%"),
  );

  return includeInactive
    ? instanceVisible
    : and(instanceVisible, eq(schema.memoryRuns.active, "TRUE"));
}
```

4. Update these query functions to respect the new active filter:
   - `listMemoryRuns({ ..., includeInactive?: boolean })`
   - `getMemoryRun(id, { includeInactive?: boolean } = {})`

5. Add a new repo-scoped updater in `src/db/repository.ts`:

```ts
export async function deactivateMemoryRunsForRepo(repo: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .update(schema.memoryRuns)
    .set({ active: "FALSE" })
    .where(and(
      eq(schema.memoryRuns.repo, repo),
      eq(schema.memoryRuns.instance, loadEnv().INSTANCE_ID),
      eq(schema.memoryRuns.active, "TRUE"),
    ))
    .returning({ id: schema.memoryRuns.id });

  return rows.length;
}
```

6. Add `active` to the dashboard `MemoryRun` type in `dashboard/src/lib/api/types.ts` so the client type stays in sync with the API payload.

7. Run `npm run db:generate` to create the migration SQL. Per repo rules, stop after generation and leave application to a human reviewer.

**Verify:**
- `npm run db:generate`
- Inspect the generated SQL to confirm:
  - enum `memory_run_active` is created
  - `memory_runs.active` is added with default `TRUE`
  - existing rows backfill to `TRUE`
  - new index is created
- `npm run build`

**Commit:**
`feat: add active state to memory runs`

### Task 2: Add a dedicated memory deletion service for filesystem + worktree cleanup

**Files:**
- Create: `src/core/memory/delete.ts`
- Modify: `src/core/memory/index.ts`
- Modify: `src/shared/config.ts` (only if you want a reusable delete task label constant; otherwise skip)

**Implementation:**
Because `src/core/memory/index.ts` is already large, keep delete orchestration in a new file instead of growing `index.ts` further.

Create `src/core/memory/delete.ts` with a small public API:

```ts
/**
 * Deletes the current on-disk memory store for one repo.
 * Removes the nested git worktree first, then removes the parent memory dir.
 */
export async function deleteRepoMemoryArtifacts(repo: string, repoPath: string): Promise<DeleteRepoMemoryResult>
```

Suggested result type:

```ts
export interface DeleteRepoMemoryResult {
  deletedWorktree: boolean;
  deletedMemoryDir: boolean;
  memoryDirPath: string;
  worktreePath: string;
}
```

Implementation details:
1. Import existing helpers from `src/core/memory/index.ts`:
   - `memoryDir(repo)`
   - `memoryWorktreeDir(repo)`
2. Look up the worktree path and remove it cleanly from git before deleting the parent folder:
   - `git worktree prune` in the main repo
   - if `checkout/` exists, run `git worktree remove --force <worktreePath>` from `repoPath`
   - run `git worktree prune` again to clear stale registrations
3. Delete the parent directory with:

```ts
await rm(memoryDir(repo), { recursive: true, force: true });
```

4. Make the helper idempotent:
   - missing `checkout/` is okay
   - missing `memoryDir` is okay
   - if the worktree metadata is stale, prune and continue
5. Keep logger usage consistent:

```ts
const log = createLogger("memory-delete");
```

Do not put DB updates in this file; keep it focused on git/fs side effects.

**Verify:**
- Manually create a memory dir for a repo and confirm the helper removes:
  - `artifacts/memory-dev-coliseum/checkout`
  - `artifacts/memory-dev-coliseum/`
- Confirm `git worktree list` in the main repo no longer contains the deleted checkout
- `npm run build`

**Commit:**
`feat: add repo memory artifact deletion service`

### Task 3: Add a repo delete API that locks, deletes artifacts, and deactivates runs

**Files:**
- Modify: `src/api/index.ts`
- Modify: `src/db/repository.ts`
- Modify: `src/core/memory/delete.ts`
- Modify: `src/core/memory/index.ts` (only if lock helpers need a tiny export adjustment)

**Implementation:**
Add a new repo-scoped endpoint:

```ts
DELETE /api/memory/repo/:repo
```

Why this path: it avoids collisions with existing `/api/memory/runs/...` routes.

Route flow in `src/api/index.ts`:
1. Resolve the repo with `getRepo(name)`; return `404` if unknown.
2. Acquire the existing memory lock with a delete-specific task ID:

```ts
const lockTaskId = `memory-delete-${name}-${Date.now()}`;
const acquired = await tryAcquireLock(name, lockTaskId);
if (!acquired) return c.json({ error: "memory delete blocked by active run" }, 409);
```

3. In a `try/finally`, call the artifact deletion helper:

```ts
const artifactResult = await deleteRepoMemoryArtifacts(name, repo.localPath);
```

4. After the filesystem delete succeeds, mark historical runs inactive for that repo:

```ts
const deactivatedRuns = await queries.deactivateMemoryRunsForRepo(name);
```

5. Release the lock in `finally`.
6. Return a structured response:

```ts
return c.json({
  repo: name,
  deletedWorktree: artifactResult.deletedWorktree,
  deletedMemoryDir: artifactResult.deletedMemoryDir,
  deactivatedRuns,
});
```

Important behavior decisions to encode:
- This is a “complete delete” of the current memory state for the current instance.
- It should not hard-delete `memory_runs` rows; it should set `active = "FALSE"`.
- After this, `GET /api/memory/status/:repo` will naturally return `missing` because `.state.json` is gone.
- After this, `GET /api/memory/runs` and `GET /api/memory/runs/:id` should hide inactive rows by default.

Optional but useful: add `includeInactive=true` support to the API layer now even if the UI does not expose it yet. That preserves operator visibility for future debugging.

**Verify:**
- `curl -X DELETE http://localhost:3333/api/memory/repo/coliseum`
- Response shows `deletedWorktree: true|false`, `deletedMemoryDir: true|false`, `deactivatedRuns: <n>`
- `GET /api/memory/status/coliseum` returns `missing`
- `GET /api/memory/runs?repo=coliseum` no longer returns the deactivated rows
- Trigger a new coding/question task for the repo and confirm the next memory execution is `cold`
- `npm run build`

**Commit:**
`feat: add repo memory delete api`

### Task 4: Add the dashboard action on the Memory page

**Files:**
- Modify: `dashboard/src/lib/api/memory.ts`
- Modify: `dashboard/src/pages/Memory.tsx`

**Implementation:**
1. In `dashboard/src/lib/api/memory.ts`, add:

```ts
export async function deleteMemoryRepo(repo: string): Promise<{
  repo: string;
  deletedWorktree: boolean;
  deletedMemoryDir: boolean;
  deactivatedRuns: number;
}> {
  return request(`/api/memory/repo/${encodeURIComponent(repo)}`, {
    method: "DELETE",
  });
}
```

2. In `dashboard/src/pages/Memory.tsx`, add repo-scoped delete UI to each repo summary card.

Recommended minimal UI:
- only show the delete action when `entry.registered === true`
- if the repo status is `missing`, either hide the action or relabel it as disabled
- place a small `delete memory` button in `RepoSummaryCard`

Add props:

```ts
interface RepoSummaryCardProps {
  entry: RepoEntry;
  now: number;
  onDelete: (repo: string) => Promise<void>;
  deleting: boolean;
}
```

Parent page behavior:
- maintain `deletingRepo: string | null`
- confirm before deleting with explicit warning text
- on success, bump `runsVersion` and refetch the page
- if delete fails with `409`, show an alert explaining that a memory run is currently active

Suggested confirmation text:

```ts
window.confirm(
  `Completely delete memory for ${repo}?\n\nThis removes the memory checkout, all saved memory files, and hides prior memory runs for this repo. The next memory build will be a cold start.`
)
```

3. Do not add the action to `MemoryDetail` for now. Delete is repo-scoped, not run-scoped, and the repo card is the right surface for v1.

**Verify:**
- Open `/memory`
- Click delete on `coliseum`
- Repo card flips to `missing`
- The old run disappears from history after refresh/refetch
- If deletion is attempted during an active run, the UI reports the block cleanly
- `npm run build`

**Commit:**
`feat: add memory delete action to dashboard`

### Task 5: Cover the new behavior with tests and manual flow verification

**Files:**
- Create: `tests/integration/api/memory-delete.test.ts`
- Create: `tests/unit/core/memory/delete.test.ts`
- Modify: `tests/integration/api/<existing api test file if memory routes are already grouped there>`

**Implementation:**
1. Add a unit test for `src/core/memory/delete.ts`:
   - mock `execFile`
   - simulate existing worktree path and memory dir
   - assert order:
     - prune
     - worktree remove
     - prune
     - rm(memoryDir)
   - assert idempotent behavior when paths are missing

2. Add an API integration test for `DELETE /api/memory/repo/:repo`:
   - mock `getRepo` / registered repo lookup as needed
   - mock `tryAcquireLock` to return `true` and `false`
   - mock `deleteRepoMemoryArtifacts`
   - mock `queries.deactivateMemoryRunsForRepo`
   - assert:
     - `404` for unknown repo
     - `409` when lock acquisition fails
     - `200` with expected JSON on success

3. Add query coverage wherever repository memory tests already live, or at minimum add a test around the API list behavior to confirm inactive rows are hidden by default.

4. Manual verification after migration review/apply:
   - build memory once for `coliseum`
   - delete it from the Memory page
   - confirm `artifacts/memory-dev-coliseum/` is gone
   - confirm `git worktree list` no longer shows the nested checkout
   - confirm the next repo task performs a cold memory run

**Verify:**
- `npm test`
- `npm run build`
- Manual dashboard + API delete flow

**Commit:**
`test: cover repo memory deletion flow`

### Task 6: Final migration/application checklist

**Files:**
- Modify: `.env.example` only if any new env var is introduced (not expected)
- Review: generated `drizzle/*.sql`

**Implementation:**
This feature should not add env vars. Final checklist:
1. Generate migration.
2. Stop for human review.
3. After approval, human runs `npm run db:migrate` from laptop.
4. Re-run:
   - `npm run build`
   - `npm test`
5. Manual Telegram/dashboard memory flow once after migration.

**Verify:**
- `npm run build && npm test`
- manual delete + next cold rebuild confirmed

**Commit:**
`chore: finalize memory delete rollout`
