# Cleanup

Deep pass over the tracked repo: backend, dashboard, scripts, tests, docs, config, schema, and migrations. Items are grouped roughly by risk: correctness bugs first, then architecture, then TypeScript hygiene, then dashboard, tests, docs, and bloat. Each item points at the file and the change.

---

## Correctness — Fix First

These are real bugs or near-bugs. Land these before anything cosmetic.

1. **Scope every DB read/write by `INSTANCE_ID`.**
   `db/repository.ts` filters list queries, but several point reads and writes do not: `getTask`, `updateTask`, `getPrSession`, `updatePrSession`, `getPrSessionBySourceTask`, `findTaskByPrNumber` (technically yes), `createTaskStage`, `updateTaskStage`, `getStagesForTask`, `createPrSessionRun`, `updatePrSessionRun`, `getRunsForPrSession`, `getRunningPrSessionRun`, `updateMemoryRun`. Anyone with a stolen UUID from another instance can read/write across instances. Fix by joining through tasks/pr_sessions on instance, or by adding an instance column to child tables and filtering at the leaf. Add tests that prove cross-instance reads/writes are rejected.

2. **DONE — Fix PR-session cleanup path.**
   `prSessionPath()` (in `core/pi/session-file.ts`) stores files at `data/pr-sessions/<id>.session/<id>.jsonl`, but `cleanupPrSession()` in `core/cleanup.ts` deletes `data/pr-sessions/<id>.jsonl`. Closed sessions never have their transcript removed. Use `prSessionPath(id)` and remove its parent directory.

3. **DONE — Await Telegram cancellation.**
   `handleTaskCancel()` in `telegram/handlers.ts` calls `cancelTask(result.task.id)` without `await`. The DB write to `cancelled` and the user reply can fire before the pi process is killed and the memory lock is released. Await it.

4. **Stop spawning `pi` directly from `pr-session/session.ts`.**
   `runSessionTurnInner` duplicates spawn, timeout, broadcast, OTel bridging, run-status updates, and `pr_session_update` emits — none of it goes through `runStage`. Extract a shared `runPiTurn()` primitive that both `runStage` and PR sessions consume, so timeouts, cancellation, and bridge wiring stay in one place.

5. **`/api/tasks/:id/cancel` race.**
   The handler awaits `cancelRunningTask(task.id)` and then writes `status: cancelled` — but the in-flight pipeline's `failTask` may fire between those two awaits and overwrite the row to `failed`. Either run cancellation as a single atomic repo update gated by status, or have the pipeline observe the cancelled flag before any DB write.

6. **`dismissTask` does not check instance.**
   `getTask(taskId)` in `core/cleanup.ts` returns rows from any instance (see #1). Dismissal of a stolen UUID can close another instance's PR. Same fix as #1.

7. **`prSessionPath` for `extractPrUrlFromSession` reads a file that does not exist yet.**
   In `pr-session/session.ts#startPrSession`, after `runSessionTurn` we call `extractPrUrlFromSession(prSession.id)`, which reads `prSessionPath(prSessionId)`. The session file is only created once pi writes its first message. If pi exits before any assistant message is produced (timeout, hard error before completion), `readSessionFile` returns `[]` and we silently fall through to "could not detect PR URL." That's acceptable behavior, but the comment in `session.ts` claims "scans the PR session's own pi session file" — surface the not-found case explicitly so failures are not silent.

8. **`startPrSession` exception path leaks the worktree.**
   If `transferTaskGitOwnership` throws (e.g. DB blip), the function leaves the original task row's `worktreePath` intact but the new `prSession` row references the same worktree under `mode: "own"`. Clean up: roll back the row creation, or set the session row to `closed` and clear branch/worktree (current code does the latter only when transfer itself fails). Audit the full set of recoverable errors from inside `startPrSession`.

9. **`/api/tasks/:id/cancel` does not respect `prSession` ownership.**
   When a coding task's PR session is the resource holder (worktree/branch are on the session row, not the task row), cancelling only the task doesn't kill the live pi turn inside the session. `cancelTask` in `core/stage.ts` only knows about task-keyed sessions (`activeSessions: Map<taskId, ...>`). PR-session turns register under `run.id`, not the source task. Add a session-scoped registry or a unified key.

10. **`oneOf` cast bypasses Zod validation.**
    `api/index.ts#oneOf` uses `value as T` after a runtime `.includes` check. Fine in isolation, but it sets a precedent: replace with a small `parseEnumQuery(schema, value)` Zod helper so the *only* place that converts strings to enums is one validated wrapper.

11. **DONE — `safeArtifactPath` allows `..` filenames in theory.**
    `ARTIFACT_NAME_PATTERN = /^[\w.-]+$/` matches `..`. The `name.startsWith(".")` check catches `..` because `..` starts with `.`. Good — but the invariant is fragile. Tighten the regex to `/^[\w][\w.-]*$/` and add a unit test for `..`, `.`, `foo/bar`, `foo\\bar`, `foo%2fbar`.

12. **Dashboard `/api/events` reconnect leaks listeners on dev hot reload.**
    `hooks/use-sse.ts` uses module-level `listeners` and `es`. Vite's hot reload can keep both around between renders if the module is replaced. Add an HMR-safe guard or recreate state per app mount.

13. **DONE — `telegram/index.ts#bot.use` swallows unauthorized requests silently.**
    The middleware just logs and returns. That's the right behavior for security, but it also returns `void` while the next handler chain has `Promise<void>` semantics — the implicit `undefined` return is fine but inconsistent with `return next()`. Make both branches `await`.

14. **DONE — `useQuery` empty deps default.**
    `dashboard/src/hooks/use-query.ts` defaults `deps = []`, suppresses `react-hooks/exhaustive-deps` with a comment, and never re-runs even if the fetcher closes over fresh state. Replace with an explicit `key: string` (string-based cache key) or accept a stable async function via `useCallback` from the caller. See item 41 below.

15. **DONE — `dashboard/src/pages/Tasks.tsx#useEffect` triggers fetches on a stringified `activeIds` dep.**
    The effect joins ids into a comma string, then splits it again — a fragile workaround for "deps must be stable across renders." Use a `Set` + `useMemo` or a per-id keyed query.

16. **`bridgeSessionToOtel` initialization race.**
    In `pr-session/session.ts#runSessionTurnInner`, the OTel bridge is attached via `trace.getActiveSpan()` after the broadcast starts. If the active span is null (it shouldn't be), the bridge silently no-ops via `() => {}`. Make this an invariant violation: throw or assert.

---

## Architecture

17. **DONE — Remove `shared -> core` imports.**
    Per `AGENTS.md`, the dependency direction is `pipelines/` → `core/` → `shared/` → `db/`, never reversed. Today:
    - `shared/repos.ts` imports `parseNwo` from `core/git/github.ts`.
    - `shared/agent-prompts.ts` imports memory IO from `core/memory`.
    Move pure URL parsing into `shared/git-urls.ts` (or similar). Move `memoryBlock` rendering into `core/memory/render.ts` (a pure function over an in-memory state) and keep `shared/agent-prompts.ts` for stage-agnostic strings only.

18. **Split the four oversized files.**
    Each is well past the 400-LOC suggested ceiling and mixes concerns:
    - `core/memory/index.ts` (658) — split into `paths.ts`, `state.ts`, `lock.ts`, `worktree.ts`, `manifest.ts`, `status.ts`, `bucketing.ts` and re-export from `index.ts`.
    - `api/index.ts` (544) — split per route group (`tasks.ts`, `memory.ts`, `pr-sessions.ts`, `events.ts`) plus a small `helpers.ts` for `oneOf`/`notFound`/`safeArtifactPath`.
    - `pipelines/pr-session/session.ts` (511) — split into `lifecycle.ts` (start/handoff/resume), `review-chat.ts`, and `runners.ts` (pi-turn primitive once #4 lands).
    - `db/repository.ts` (481) — split per aggregate: `tasks.repo.ts`, `stages.repo.ts`, `pr-sessions.repo.ts`, `memory-runs.repo.ts`, `reaper.ts`. Keep `index.ts` as a thin re-export so call sites stay `import * as queries from "./repository"`.

19. **Make wire types real contracts at every boundary.**
    The dashboard hand-types API responses and `client.ts#request<T>` does `res.json() as Promise<T>`. We already have Zod schemas for PR review (`prReviewPageDtoSchema`, `reviewChatResponseSchema`); extend that pattern: Zod schemas for `Task`, `TaskStage`, `PrSession`, `MemoryRun`, `MemoryStatus`. Have `client.request` accept a schema and call `safeParse`. Same for SSE: `hooks/use-sse.ts` casts `JSON.parse(e.data) as SSEEvent` — replace with one Zod parse on entry.

20. **Remove enum duplication between schema.ts and types.ts.**
    `db/schema.ts` inlines enum values (`pgEnum("task_kind", ["coding_task", ...])`). `shared/types.ts` declares the same arrays as `as const`. There's no mechanism that proves they stay in sync. Either:
    - Generate `pgEnum` arrays from the shared `as const` arrays (drizzle-kit can load `.ts` via `tsx`; the comment that says it can't is now outdated for v0.30+), or
    - Add a unit test that imports both and asserts deep equality. The test is small and removes a real footgun.

21. **`prSessionRuns.status` and `.trigger` should be enums.**
    `schema.ts` declares both as `text` and the comments enumerate the legal values inline. Promote both to `pgEnum` (the migration is a pure constraint-add) and a corresponding `as const` array in `shared/types.ts`. Repo writes will then be type-checked.

22. **`memoryRunActive` as `"TRUE"|"FALSE"` strings is awkward.**
    `pgEnum("memory_run_active", ["TRUE", "FALSE"])` exists because boolean defaults were painful at one point. With Drizzle's current Postgres support there's no reason not to use `boolean("active").notNull().default(true)`. Migration is straightforward; the dashboard already maps `"TRUE"` to "active" implicitly. Remove the string enum.

23. **`prSessionRuns.comments: jsonb("comments")` is `unknown`.**
    Validate it with `PrComment[]` Zod on read and on write. Today the dashboard happily renders whatever is there. Dashboard's `PrSessionRun.comments: PrComment[] | null` is hopeful, not enforced.

24. **Cancellation registry double-state.**
    `core/stage.ts` keeps two parallel maps (`activeSessions` per task → stage map, plus `cancelledTasks` set). The "register-on-spawn / clear-in-finally" dance is correct but spread across `setActiveSession`, `clearActiveSession`, `cancelTask`, `runStage`. Wrap into a single `TaskRunRegistry` class with `register`, `unregister`, `cancel(taskId)`, `isCancelled(taskId)`. Pipelines stop touching the maps; only the class does. Bonus: it can encapsulate the immutability convention (the current code mutates the outer Map).

25. **`isPersistedTaskId` is duct tape.**
    Tests pass synthetic taskIds like `"test-foo"`. `runStage` short-circuits the DB writes when the id isn't a UUID. That's fine for a unit test, but it leaks test-awareness into production code. Replace with an explicit `persistTaskRows: boolean` option on `runStage` — pipelines pass `true`, scripts/tests pass `false`. Same call-site complexity, no string sniffing.

26. **`shared/test-instance.ts` is production-loaded.**
    `db/repository.ts#memoryRunsVisible` includes a `LIKE "${TEST_INSTANCE_PREFIX}%"` clause so manual-test runs are visible alongside real ones. That's a correctness foot-gun: production traffic now has to scan an extra OR clause forever. Move to a query option (`includeTestInstances`) callers opt into; default off. Today the API always includes them, which is wrong for prod.

27. **`config.ts` mixes concerns.**
    The file holds the env Zod schema, the resolver helpers, *and* a `config` object with hardcoded paths. Split into `shared/env.ts` (loadEnv + resolveModel) and `shared/paths.ts` (the `config` object). Importing one shouldn't pull in the other.

28. **`shared/llm.ts` retry policy lives at call sites.**
    `core/git/worktree.ts#generateBranchName` retries 3× with bumped temperature; `intent-classifier.ts` retries zero times; `pr-review/analyst.ts` does not retry. Hoist a `withRetry({ attempts, onAttempt })` into `shared/llm.ts` so retry logic is one place.

29. **DONE — Repo registry leaks `localPath` to the dashboard.**
    `GET /api/repos` returns `listRepos()` directly, which includes `localPath`. The dashboard never needs this. Add a `Repo` DTO in `shared/repos.ts` (`{name, githubUrl?}`) and serialize that on the wire. Same for `worktreePath` on `Task` and `PrSession` rows — the dashboard never opens those paths.

30. **DONE — `api` reads `dashboard/dist/index.html` from disk on every SPA fallback request.**
    `src/index.ts:102`. Cache the file contents at startup; rebuild only on dev. Tiny win, but the current code has zero reason to hit disk per request.

---

## TypeScript Coding Practices

A learning-focused section. Each item links a concrete pattern with at least one offending site so the rule is obvious.

### Stricter compiler options

31. **Enable stricter `tsconfig` flags in phases.**
    Today `tsconfig.json` has only `"strict": true`. Add (one at a time, fix fallout, commit):
    - `noUnusedLocals`, `noUnusedParameters` — small cleanup, exposes dead code.
    - `noFallthroughCasesInSwitch` — `telegram/handlers.ts#handleIntent` is an exhaustive switch; the flag adds insurance.
    - `noImplicitOverride` — only useful once classes show up; `shared/errors.ts` patterns are fine.
    - `exactOptionalPropertyTypes` — biggest payoff. Surfaces every `prop?: T` you assign `undefined` to (see #34).
    - `noUncheckedIndexedAccess` — exposes `array[i]` returning `T | undefined`. You'll find dozens of spots, and most are real (e.g. `displayPrompts.ts`, parsers in `transcript.ts`).
    - `noPropertyAccessFromIndexSignature` — minor, low signal.
    - `useUnknownInCatchVariables` — already implied by strict; double-check `catch (err)` sites use `unknown`.
    Run them under `npm run typecheck:strict` first; promote to default once green.

32. **Enable `verbatimModuleSyntax`.**
    Forces `import type { Foo }` for type-only imports, eliminates accidental runtime imports of types. Combined with `isolatedModules` it gives consistent module shape — useful when bundlers (Vite) and Node need to agree.

### Optional vs nullable

33. **Pick one missing-value convention per layer.**
    Today the code mixes `T | undefined`, `T | null`, and `T | undefined | null` freely:
    - DB row types (Drizzle) → `T | null` (Postgres NULL).
    - Function args → `T | undefined` via optional `?:`.
    - API DTOs → choose one and document it.
    Pick a rule: "DB layer returns `null`, application layer returns `undefined`, network DTOs use `null` (so JSON round-trips cleanly)." Add a `nullToUndefined` helper for the seam, lint the rest.

34. **Stop passing explicit `undefined` into optional props.**
    Once `exactOptionalPropertyTypes` is on, this fails. Examples already in code:
    ```ts
    // core/stage.ts
    sessionEventMeta: tracker.runId ? { memoryRunId: tracker.runId } : undefined,
    // observability/spans.ts
    ...(ctx.startTime !== undefined ? { startTime: ctx.startTime } : {}),
    ```
    Build the object conditionally rather than assigning `undefined` to a property whose type is `T?`. The second example is already correct; the first is not.

### Validate at trust boundaries

35. **`as` casts after `JSON.parse` are everywhere.**
    Every parse-and-cast pair is a quiet trust violation:
    - `core/pi/session-file.ts#parseLine`: `JSON.parse(trimmed) as FileEntry`. Pi's session schema is non-trivial; one shape mismatch becomes a render bug. Wrap in a Zod schema (or hand-rolled `isFileEntry` type guard) once and reuse.
    - `core/git/github.ts#getPrMetadata`: `JSON.parse(stdout) as { number: number; ... }`. Same problem. Build a Zod schema, throw a typed error on mismatch.
    - `core/pi/spawn.ts`: `JSON.parse(line) as PiEvent` and the subsequent `event.method as string`, `event.id as string`. Add a runtime-validated `PiEvent` discriminator.
    - `dashboard/src/lib/api/client.ts#request<T>`: `res.json() as Promise<T>`. Make `request` schema-aware (#19).
    - `dashboard/src/hooks/use-sse.ts`: `JSON.parse(e.data) as SSEEvent`. Same fix.

36. **Non-null assertions (`!`) in core IO paths.**
    `core/pi/spawn.ts` accesses `proc.stdin!`, `proc.stdout!`, `proc.stderr!` four times. These are technically safe because we spawn with `stdio: ["pipe", "pipe", "pipe"]`, but the `!` hides that contract. Either:
    - Pull a tiny `assertPipes(proc)` helper that throws if any stream is null and returns a `{stdin, stdout, stderr}` triple, or
    - Use `unwrap(proc.stdin, "stdin")` once at the top.
    The same applies to `validatedZones!` in `pipelines/memory/pipeline.ts`. Replace the `let validatedZones: Zone[] | null = null` mutable + non-null cast with a result-returning postValidate (`postValidate: () => Promise<{valid: true, zones} | {valid: false, reason}>`). Then there is no nullable variable.

### Discriminated unions

37. **Prefer discriminated unions over parallel optional fields.**
    Already done well in `Intent` and `LockInspection`. Two regressions to fix:
    - `PrSessionRun.comments: PrComment[] | null` plus `trigger: string` could be `{ trigger: "comments"; comments: PrComment[] } | { trigger: "pr_creation" } | { trigger: "review_chat"; context: ... }`. Then the schema enforces "only `comments` triggers carry comments."
    - `MemoryRun.originTaskId | externalLabel` (one of the two is always null based on `source`). Express as `{source: "task"; originTaskId: string} | {source: "manual_test"; externalLabel: string}` at the application boundary; keep the wide row only at the DB seam.

38. **`StageResult` and `LockInspection` are the right shape — apply the pattern more widely.**
    Sites where it'd help:
    - `runStage`'s `postValidate`: today returns `{valid: false, reason?: string}`; make it `{valid: true, data: T} | {valid: false, reason: string}` so consumers can attach typed payload (see #36).
    - `withMemoryRun`'s `Promise<"ran" | "lock_held">`: fine, but consider `{kind: "ran"; result: T} | {kind: "lock_held"}` so callers don't always have to bolt the run's output onto a closed-over variable.

### Immutability

39. **Pipelines mutate Maps and Sets.**
    `core/stage.ts#cancelTask`:
    ```ts
    cancelledTasks.add(taskId);
    activeSessions.delete(taskId);
    ```
    The AGENTS.md rule "never mutate arrays or objects" is technically about user data; module-level registries are inherently mutable. But the convention is followed inconsistently within `setActiveSession`, which builds a new inner Map but then mutates the outer one with `.set`. Settle on either "all internal mutation is fine, scoped to this module" or "the whole module is immutable via copy-on-write" and apply once. The current 50/50 split confuses readers.

### Naming and shape

40. **Module-level singletons should be readonly to the outside.**
    `_env`, `_db`, `locksHeldByTask`, `activeSessions`, `inFlight`, `refreshInFlight`, `timer`. Most are well-encapsulated. `inFlight` (poller) and `refreshInFlight` (api) live at module top — fine, but consider `Object.freeze({add, has, delete})` exports if you want to be paranoid. Mostly: keep them, and ensure no test imports them directly.

41. **DONE — The `useQuery` deps escape hatch is a learning trap.**
    Reasoning about *why* `eslint-disable react-hooks/exhaustive-deps` is "safe here" is hard. Replace the call signature with one of:
    - Cache-key based: `useQuery(key: string, fn: () => Promise<T>)`. Refetch when `key` changes; never inspect `fn`.
    - Stable-fn based: require callers to pass `useCallback(fn, deps)`. Then exhaustive-deps just works.
    This is a TS-specific lesson: hooks that take a function are fragile because functions are reference-typed. Either re-render on a value, or force the caller to stabilize the reference.

### Errors

42. **Centralize sentinel error classes.**
    `ReviewChatNotFoundError`, `ReviewChatBusyError`, `ReviewChatUnavailableError` live in `pr-session/session.ts` only. `TaskCancelledError` lives in `core/stage.ts`. Keep them where they're thrown, but standardize on a base:
    ```ts
    export abstract class GoodboyError extends Error {
      abstract readonly code: string;
      abstract readonly httpStatus: number;
    }
    ```
    Then `api/index.ts` has one `instanceof GoodboyError` branch instead of three. The pattern teaches a generally useful TS lesson: *error metadata travels with the error class, not with the call site.*

43. **`toErrorMessage` swallows structured info.**
    Returning `String(err)` for non-Error throws is fine; the LLM and gh wrappers throw richer info that gets stringified ("Error: foo" instead of `{ status, body }`). When you start adding typed errors (#42), surface their fields.

### Type ergonomics

44. **`as const` arrays are good — push them harder.**
    Pattern is well used (`TASK_KINDS`, `STAGE_NAMES`). Apply consistently:
    - `WORKER_VERBS` in `ReviewChat.tsx` is good.
    - `HISTORY_FILTERS` in `Tasks.tsx` is good.
    - `prSessionRuns.trigger` strings (see #21) should be one too.

45. **Drop `interface` vs `type` indecision.**
    Repo currently uses `interface` for object shapes (good) and `type` for unions/aliases. That's the right rule. Two regressions: `dashboard/src/lib/api/types.ts` declares `Task`, `TaskStage` as `interface` while the backend returns `Task = typeof tasks.$inferSelect` which is a type. Once #19 lands, the dashboard interface declarations vanish (replaced by `z.infer` of the shared schema).

46. **Avoid `Partial<{...}>` in repo updates.**
    `db/repository.ts#updateTask`, `updateTaskStage`, etc. take `Partial<{ status: TaskStatus; ... }>`. With `exactOptionalPropertyTypes` and a strict caller, the inferred argument types degrade. Replace with explicit `interface UpdateTaskInput { status?: TaskStatus; ... }` (named, exported, easy to grep). Also helps when a field needs `string | null` semantics distinct from "absent."

47. **Avoid `Record<string, unknown>` for typed objects.**
    `bridge/translate.ts#flattenAttrs` converts unknown to `Record<string, string | number | boolean>`. Fine here because OTel attributes really are scalar-only. But `core/pi/spawn.ts#PiEvent extends { type: string; [key: string]: unknown }` is too loose — you immediately have to cast every field. Replace with a discriminated union of the events you actually handle (`PromptResponse`, `AgentEnd`, `ExtensionUiRequest`, `Response`).

48. **Path-alias consistency.**
    Backend uses `.js` extensions on internal imports (good). Dashboard uses `@dashboard/*` aliases (good). One inconsistency: `dashboard/src/components/log-viewer/index.ts` re-exports with explicit `.js` while `tests/` import paths use `@src/...`. Document the alias contract in `AGENTS.md` so future contributors don't reintroduce relative-path imports.

49. **`readonly` is under-used.**
    `shared/llm.ts` correctly uses `readonly` on every field of `ChatMessage`/`CompleteOptions`. Most other interfaces in the codebase are missing it (`PiSession`, `Repo`, `RunStageOptions`, `StageContext`, dashboard types). For DTOs and option bags, `readonly` is free safety. Add a lint rule once you adopt eslint.

50. **Branded types for ids.**
    Many functions take `(taskId: string, prSessionId: string)` and at one point pass them in the wrong order would compile. Cheap improvement: branded types in `shared/types.ts`:
    ```ts
    export type TaskId = string & { readonly __brand: "TaskId" };
    export type PrSessionId = string & { readonly __brand: "PrSessionId" };
    ```
    Plus narrow constructors (`asTaskId(s: string): TaskId` that runs a UUID regex). Optional but high-leverage for a learning project.

### React-specific

51. **Props named `interface FooProps` above the function.**
    Already mostly followed. Two stragglers: `LogViewer.tsx` (interface `LogViewerProps`) is fine; `MemoryDetail.tsx` and `Repos.tsx` skip the interface and inline destructure. Consistency lets readers find prop docs in one place.

52. **`useRef` for the latest callback is correct — codify it.**
    `use-sse.ts`, `use-live-session.ts`, `use-query.ts` all use `useRef` to hold the latest fn. That's the right idiom for "subscribe once, but call the fresh closure." Worth a one-paragraph note in the dashboard docs so newcomers don't dispatch into `useEffect([fn])` and create an infinite loop.

53. **Avoid `useState` initializers that run effects.**
    `ResizablePanels.tsx#loadSize` reads `localStorage` from the lazy initializer. Acceptable. But several pages use `useState(() => new Set(allFiles))` which can re-run on prop changes — see `PrReview.tsx`. Move that into a `useEffect` keyed on the prop. The current code does this for `headSha` already; do the same for the initial set.

---

## Dashboard

54. **DONE — Lazy-load the PR diff viewer.**
    `vite build` emits hundreds of Shiki language/theme chunks because `@pierre/diffs` is imported eagerly into the main route. Lazy-load `PrReview.tsx` (or just `FileStack.tsx` / `FileDiff.tsx`) via `React.lazy` so the dashboard's shell ships < 200 KB.

55. **DONE — Remove inline `style={}` for color/spacing.**
    Existing offenders: `ResizablePanels.tsx` (geometry — keep), `AnnotationPopup.tsx` (positioning — keep), `LogViewer.tsx` (`style={{ maxHeight }}` — keep, height comes from prop). All current uses are geometry-only. Document the carve-out so the rule "no inline styles" doesn't get applied to the legitimate cases.

56. **PARTIAL — Remove dead props and `// TEMP:` markers.**
    - `ReviewChat` accepts `prNumber` and `branch` and uses neither.
    - `diffUpdatedAt` is marked `// TEMP:` in the API, the shared schema, and the UI. Either commit to it (rename to `diffRefreshedAt`, drop the comment, render unconditionally) or delete it.
    - `extractReviewChatMessages` in transcript.ts uses `entry.message.role !== "user"` plus a re-check inside the loop; tighten the early continue.

57. **DONE — Replace the `useQuery` lint escape.**
    See #14 / #41. This is the biggest readability win in the dashboard.

58. **Stop fetching `fetchTask` for every active task.**
    `Tasks.tsx` issues N parallel `fetchTask(id)` calls just to populate `PipelineProgress`. Add a `?include=stages` query param to `/api/tasks` that returns stages inline; one round-trip instead of N+1.

59. **`Markdown.tsx` ships the full `react-markdown` + `remark-gfm` bundle.**
    Used in 3 places. Code-split if any page doesn't need markdown (e.g. `Tasks.tsx`).

60. **`ErrorBoundary` should report to observability.**
    `dashboard/src/components/ErrorBoundary.tsx` exists; it likely just shows fallback UI. Wire it to send a single OTel/Logfire event so dashboard JS errors surface in the same dashboard as backend failures.

61. **`use-sse.ts` reconnect uses fixed backoff.**
    `SSE_RETRY_MS` is a constant. Add jittered exponential backoff so a flapping server doesn't get a thundering herd from every dashboard tab.

62. **Dashboard `cn()` is just `clsx`.**
    `dashboard/src/lib/utils.ts#cn` wraps `clsx` and re-exports it. AGENTS.md says "use `cn()` for every conditional class." Either drop the wrapper (just import `clsx as cn`) or add `tailwind-merge` so `cn("p-2", maybeOverride)` deduplicates. The wrapper without merge is half a feature.

---

## Tests

63. **Add repository isolation tests.**
    Prove that `getTask`, `updateTask`, `getPrSession`, `updatePrSession`, `dismissTask`, `getMemoryRun`, etc. cannot see or mutate rows from another `INSTANCE_ID`. (Targets fix #1.)

64. **Add a cleanup test for PR-session transcript deletion.**
    Targets fix #2: write a session file via `prSessionPath`, run `cleanupPrSession`, assert the file (and its parent dir) are gone.

65. **Add a Telegram cancel test.**
    Targets fix #3: assert `cancelTask(...)` is awaited and the DB write to `cancelled` happens after pi has been killed.

66. **Cover `pipelines/pr-session/session.ts`.**
    Currently entirely uncovered. Once #4 lands and the pi-turn primitive exists, this becomes testable: mock the primitive, drive `startPrSession`, `resumePrSession`, `runReviewChatTurn`, assert DB writes + SSE emits.

67. **Cover `core/stage.ts`.**
    `runStage` is the heart of the system and has zero tests. With the `TaskRunRegistry` extraction (#24) and a fake `spawnPiSession`, you can drive happy/timeout/cancellation paths in unit tests.

68. **Cover `db/repository.ts`.**
    Today no tests. Use Drizzle's in-memory or a transactional Postgres test harness. Even a smoke test ("createTask + getTask returns it; getTask from a different instance returns null") would have caught #1.

69. **Add a strict-type CI check after cleanup.**
    Run the stricter `tsc` flags (#31) as a separate `tsc --noEmit -p tsconfig.strict.json` script. Promote when green.

70. **Add a schema-vs-types parity test.**
    Iterate over each shared `as const` array and assert it matches the corresponding `pgEnum` array. Self-documenting drift detector. (Targets #20.)

71. **Pin pi session schema with a fixture.**
    `tests/unit/core/session-file.test.ts` exists; add a minimal "v3 fixture file from real pi run" snapshot so `CURRENT_SESSION_VERSION` bumps don't go undetected.

---

## Documentation

72. **`README.md` is partially stale.**
    - Says `pr_review` is "stubbed (not active yet)" — it is implemented and shipping.
    - API surface lists `/api/prs` (does not exist) and is missing `/api/memory/*`, `/api/pr-sessions/:id/review`, `/api/pr-sessions/:id/review-chat`, `/api/pr-sessions/:id/watch`.
    - Project layout claims `pipelines/cleanup` (folder doesn't exist; cleanup is `core/cleanup.ts`).
    - Stage list is wrong: planner / implementer / reviewer / pr_creator are the four for coding tasks, but the table only lists three. Memory and pr_review stages are missing from the kinds table.

73. **`docs/architecture.md` should be the canonical map.**
    `AGENTS.md` says "Deeper explanation lives in docs/architecture.md." Audit it against the current `src/` tree once #18 lands.

74. **PARTIAL — `AGENTS.md` rules vs reality drift.**
    - "No `console.log`" — `scripts/` legitimately uses `console.*` and isn't called out (see #79).
    - "Every backend file declares `const log = createLogger(...)`" — `shared/errors.ts`, `shared/repos.ts`, `shared/types.ts`, `shared/test-instance.ts`, and `shared/artifacts.ts` are all backend and don't. They probably shouldn't (pure utility), so the rule should read "every backend file *with side effects*."
    - "Immutability: never mutate arrays or objects" — broad to a fault (see #39). Restate as "function args are immutable; module-private mutation is allowed and encapsulated."
    - "Magic numbers live in `shared/config.ts` or `shared/limits.ts`" — `shared/limits.ts` does not exist. Either create it (and migrate the `30 * 60 * 1000` style constants spread across `core/stage.ts`, `pipelines/pr-session/session.ts`, `core/memory/index.ts`) or drop the reference.

75. **`.env.example` is missing `INSTANCE_ID` description, missing `LOGFIRE_*` non-token settings.**
    Either document each var with a comment, or generate `.env.example` from the Zod schema in `shared/config.ts` so they stay in sync.

76. **No CHANGELOG, no migration log.**
    Schema migrations land via `drizzle/`. Consider a one-line `drizzle/CHANGES.md` so reviewers can see "what changed in 0007_…sql" without diffing the SQL.

---

## Bloat / Hygiene

77. **DONE — Generated/runtime folders pollute local scans.**
    `artifacts/`, `data/`, `dashboard/dist/`, `handoffs/`, `docs/plans/` are gitignored but consume rg time. Add a `.ripgreprc` (or document `rg --type-add 'goodboy:*.{ts,tsx}' -tgoodboy`) so contributors don't accidentally grep through generated session JSONL.

78. **Tracked file `frontend.pen` (1.3 MB) is in repo root.**
    Almost certainly not needed in source control. Move it to `assets/` or remove.

79. **DONE — Decide whether `scripts/` is exempt from app rules.**
    Scripts use `console.*`, dynamic `import()`, and top-level await — all reasonable for CLIs. Either:
    - Add `// @goodboy/script` header convention plus an eslint override for `scripts/**`, or
    - Wrap output in a tiny `createScriptLogger()` that just hits `process.stdout.write`. Pick one and codify in AGENTS.md.

80. **DONE — `tests/scripts/` mixes test scripts and production fixtures.**
    `_memory-test-common.ts`, `clean-memory-tests.ts`, `run-memory-cold.ts`, `run-memory-warm.ts`, `run-telegram-intent-latency.ts`. These aren't tests, they're benchmarks/helpers. Move to `bench/` or `scripts/dev/` to clarify.

81. **PARTIAL — Narrow overbroad style rules in AGENTS.md.**
    See #74. Tools to enforce what's left: add ESLint with `eslint-plugin-functional` (no-let-in-functions optional) and a custom rule for "no imports from `core/*` inside `shared/*`." Until tooling exists, the rules are aspirational.

82. **Remove `dist/` from the repo if it's tracked.**
    `dist/` exists at repo root with timestamps from April 21. Confirm it's gitignored; if so, delete the local copy. If not, gitignore and remove from history (one rebase, follow-up later).

83. **`pi-assets/` is 96 bytes — fine. `node_modules/` is 12 KB of entries — fine.**
    Skip.

---

## Quick win checklist

If you want a tight first PR, the highest-value items with the least blast radius:

- #2 (cleanup path)
- #3 (await cancel)
- #11 (regex tighten + test)
- #14 / #41 (useQuery escape)
- #34 (`exactOptionalPropertyTypes` blockers — small)
- #56 (delete dead `prNumber`/`branch` props)
- #62 (decide on `cn()`)

Larger refactors (#4, #18, #20, #24) are best-of-N candidates: each is a self-contained PR with tests.
