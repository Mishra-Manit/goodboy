# PR Session Watch Muting Implementation Plan

**Goal:** Let operators stop auto-review polling for a specific PR session without deleting the session, closing the PR, or losing run history.
**Approach:** Add a separate watch-state field on `pr_sessions`, keep lifecycle status (`active` vs `closed`) unchanged, and teach the poller to keep doing lifecycle cleanup while skipping comment-triggered resumes for muted sessions. Expose a small action endpoint plus dashboard controls to mute/resume watching, and advance the existing comment cursor on state changes so comments left during mute are ignored.
**Stack:** TypeScript, Hono, Drizzle, Neon, Vite React, SSE, Vitest

---

### Task 1: Add PR-session watch state to the data model

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/repository.ts`
- Modify: `src/shared/types.ts`
- Modify: `dashboard/src/lib/api/types.ts`
- Create: `drizzle/<generated migration file>`

**Implementation:**
- In `src/db/schema.ts`, add a new enum and column on `pr_sessions`:
  ```ts
  export const prSessionWatchStatusEnum = pgEnum("pr_session_watch_status", [
    "watching", "muted",
  ]);

  export const prSessions = pgTable("pr_sessions", {
    // ...existing columns
    watchStatus: prSessionWatchStatusEnum("watch_status").notNull().default("watching"),
  });
  ```
- Keep `status` exactly as-is (`active` | `closed`). Do not overload it.
- In `src/db/repository.ts`:
  - let `createPrSession()` rely on the DB default or explicitly set `watchStatus: "watching"`
  - extend `updatePrSession()` to accept `watchStatus: "watching" | "muted"`
  - keep `listActivePrSessions()` returning all active sessions so muted sessions can still be checked for PR closure and cleaned up
- In `src/shared/types.ts`, add a shared `PrSessionWatchStatus` union and extend any SSE event types added later.
- In `dashboard/src/lib/api/types.ts`, add:
  ```ts
  export type PrSessionWatchStatus = "watching" | "muted";
  ```
  and include `watchStatus` on `PrSession` / `PrSessionWithRuns`.
- Run `npm run db:generate` to create the SQL migration.
- Stop after generation for human review before applying it, per repo rules.

**Verify:**
- `npm run db:generate`
- Inspect generated SQL and confirm it adds only the enum + `watch_status` column with default `watching`
- `npm run build`

**Commit:**
`feat: add pr session watch status`

---

### Task 2: Teach the poller to respect mute without breaking cleanup

**Files:**
- Modify: `src/pipelines/pr-session/poller.ts`
- Modify: `src/pipelines/pr-session/session.ts`

**Implementation:**
- In `src/pipelines/pr-session/poller.ts`, keep the top-level flow the same:
  1. load all active PR sessions
  2. skip sessions already in-flight or missing `prNumber`
  3. still call `isPrClosed()` for every active session
  4. if closed, run `cleanupPrSession(session.id)`
- Insert the mute gate after the PR-closed check and before fetching comments:
  ```ts
  if (session.watchStatus === "muted") {
    return;
  }
  ```
- Leave the existing comment filtering logic (`lastPolledAt`) in place.
- In `src/pipelines/pr-session/session.ts`, keep `lastPolledAt` updates after create/resume/external-review success. No behavior change needed there besides compiling against the new field.
- Do not update `lastPolledAt` every muted poll cycle. The cursor should instead be advanced when the operator explicitly mutes or unmutes the session.

**Verify:**
- `npm run build`
- Manual reasoning check: an `active + muted` session still gets cleaned up once the PR closes, but does not fetch comments or call `resumePrSession`

**Commit:**
`feat: skip muted pr sessions in poller`

---

### Task 3: Add a backend action endpoint to mute/resume a PR session

**Files:**
- Modify: `src/api/index.ts`
- Modify: `src/db/repository.ts`
- Modify: `src/shared/types.ts`
- Modify: `dashboard/src/lib/api/pr-sessions.ts`

**Implementation:**
- Add a small action endpoint in `src/api/index.ts`, consistent with existing action-style routes:
  ```ts
  app.post("/api/pr-sessions/:id/watch", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const watchStatus = body?.watchStatus;

    if (watchStatus !== "watching" && watchStatus !== "muted") {
      return c.json({ error: "invalid watchStatus" }, 400);
    }

    const session = await queries.getPrSession(id);
    if (!session) return notFound(c);

    const updated = await queries.updatePrSession(id, {
      watchStatus,
      lastPolledAt: new Date(),
    });

    emit({ type: "pr_session_watch_update", prSessionId: id, watchStatus });
    return c.json(updated);
  });
  ```
- Advancing `lastPolledAt` on both mute and unmute means:
  - comments left before muting are already handled or ignored
  - comments left during mute are not replayed when unmuted
  - watching restarts from “now”, which matches the product goal
- In `dashboard/src/lib/api/pr-sessions.ts`, add:
  ```ts
  export async function setPrSessionWatchStatus(id: string, watchStatus: PrSessionWatchStatus): Promise<PrSession> {
    return request(`/api/pr-sessions/${id}/watch`, {
      method: "POST",
      body: JSON.stringify({ watchStatus }),
    });
  }
  ```
- In `src/shared/types.ts`, add an SSE event shape that does not collide with the existing running-state event:
  ```ts
  | { type: "pr_session_watch_update"; prSessionId: string; watchStatus: PrSessionWatchStatus }
  ```
  This avoids overloading `pr_session_update`, which currently means `running: boolean`.

**Verify:**
- `npm run build`
- `npm test`
- Manual API check with app running:
  - `POST /api/pr-sessions/:id/watch` with `{"watchStatus":"muted"}` returns 200 and updated JSON
  - invalid payload returns 400
  - unknown ID returns 404

**Commit:**
`feat: add pr session mute action endpoint`

---

### Task 4: Add dashboard controls for mute/resume watching

**Files:**
- Modify: `dashboard/src/components/rows/PrSessionRow.tsx`
- Modify: `dashboard/src/components/SessionHeader.tsx`
- Modify: `dashboard/src/components/StatusBadge.tsx`
- Modify: `dashboard/src/pages/PullRequests.tsx`
- Modify: `dashboard/src/pages/PrSessionDetail.tsx`
- Modify: `dashboard/src/lib/api/pr-sessions.ts`
- Modify: `dashboard/src/lib/api/types.ts`

**Implementation:**
- In `dashboard/src/components/StatusBadge.tsx`, add a muted badge config:
  ```ts
  muted: { label: "muted", color: "text-warn" },
  ```
- In `dashboard/src/components/rows/PrSessionRow.tsx`:
  - add `watchStatus`-aware button text: `Stop watching` or `Resume watching`
  - keep row navigation on the main row click, but stop propagation for the action button
  - when `watchStatus === "muted"`, show the muted badge instead of the generic active/watching badge
  - hide the `polled ...` text when muted, because the session is intentionally not being polled
- In `dashboard/src/components/SessionHeader.tsx`, add the same action button near the metadata so detail view can control it too.
- In `dashboard/src/pages/PullRequests.tsx` and `dashboard/src/pages/PrSessionDetail.tsx`:
  - wire the new action to `setPrSessionWatchStatus`
  - refetch after success
  - subscribe `useSSERefresh` to both `pr_session_update` and `pr_session_watch_update`
- Keep the current list structure (`active sessions`, `closed sessions`) for v1. Muted sessions stay in active sessions because they are still active lifecycle-wise.

**Verify:**
- `npm run build`
- Manual UI flow under `npm run dev`:
  - mute from the PR Sessions list
  - refresh page and confirm badge/action persist
  - resume from the detail page
  - confirm the row switches back to watching

**Commit:**
`feat: add dashboard controls for muted pr sessions`

---

### Task 5: Add backend regression tests for the new behavior

**Files:**
- Create: `tests/unit/pipelines/pr-session-poller.test.ts`
- Create: `tests/integration/api/pr-session-watch.test.ts`
- Modify: `tests/unit/pipelines/cleanup.test.ts`

**Implementation:**
- Add `tests/unit/pipelines/pr-session-poller.test.ts` covering:
  - muted session skips `getPrComments`, `getPrReviewComments`, and `resumePrSession`
  - muted session still calls `isPrClosed`
  - closed muted session still triggers `cleanupPrSession`
  - watching session still resumes normally when comments exist
- Add `tests/integration/api/pr-session-watch.test.ts` patterned after `tests/integration/api/memory-delete.test.ts`:
  - 404 for unknown session
  - 400 for invalid `watchStatus`
  - 200 for `muted` and `watching`
  - assert `updatePrSession()` gets both `watchStatus` and `lastPolledAt`
- In `tests/unit/pipelines/cleanup.test.ts`, keep existing cleanup expectations, and if needed assert that `cleanupPrSession()` still hard-closes sessions regardless of watch state.

**Verify:**
- `npm test`
- `npm run build`

**Commit:**
`test: cover pr session mute behavior`

---

### Task 6: Manual validation in the real app

**Files:**
- No code changes required

**Implementation:**
- Run the full app locally and test the exact operator workflow:
  1. Create or pick an active PR session
  2. Mute it from the dashboard
  3. Leave a GitHub comment on the PR
  4. Wait one poll cycle and confirm no PR-session resume run is created
  5. Unmute it
  6. Leave a new comment after unmuting
  7. Confirm only the new comment triggers a resume run
  8. Close the PR while muted and confirm the session is still cleaned up
- Watch dashboard state, backend logs, and `pr_session_runs` behavior during the test.

**Verify:**
- `npm run dev`
- `npm test`
- `npm run build`
- Manual Telegram/dashboard/GitHub check of the mute/unmute flow

**Commit:**
`chore: validate pr session mute flow`
