# Dashboard Refactor Plan

**Goal:** Bring the Vite React dashboard under the same file-shape, naming, size, and pure/IO-seam rules that the backend was just refactored to.
**Approach:** Work directly on `main` as one continuous refactor — no branch, no per-task commits. Land the whole thing as a single working-tree change the user reviews at the end. Order the work so the tree stays build-green after each task (useful as a checkpoint to run `npm run build`), but do not commit between tasks. Start with cross-cutting plumbing (shared types, log grouping extraction, comment style), then split the biggest offenders (`LogViewer.tsx` 934 LOC, four pages >300 LOC, 227 LOC `api.ts`), then formalize page-state and status helpers so pages shrink. No feature changes. Finish with a docs / index.css polish pass.
**Stack:** Vite 8 + React 18 + React Router + Tailwind v4 + Lucide + react-markdown. No new runtime deps.

---

## Why these changes (ground truth, one paragraph each)

### 1. Shared wire types are hand-duplicated

`AGENTS.md` → **"When Editing the Dashboard"** says, verbatim: *"Shared wire types live in `src/shared/types.ts`. The dashboard consumes them via `@goodboy/shared` or a narrow re-export; never hand-duplicate `TaskStatus`, `TASK_KIND_CONFIG`, etc."* Today `dashboard/src/lib/api.ts` redeclares `TaskKind`, `TaskStatus`, `StageStatus`, `LogEntryKind`, `PrSessionStatus`, and even `TASK_KIND_CONFIG` (a new invention that has no backend counterpart). The backend has `TASK_KINDS`, `TASK_STATUSES`, `STAGE_STATUSES`, `LOG_ENTRY_KINDS`, `PR_SESSION_STATUSES` as `as const` arrays in `src/shared/types.ts`. The TS union source of truth must be one file.

### 2. File-shape rules aren't followed yet

`AGENTS.md` → **"Docstrings and file shape"**:

- Every file ≥2 exports gets a `/** role */` header. Dashboard: **zero** files have one.
- Section dividers: `// --- Title ---` — short dashes, Title Case. Dashboard: most files use `/* ── Title ── */` (unicode box chars), `PrSessionDetail.tsx` and `PullRequests.tsx` use **long-bar banners** (`// ---------------------------------------------------------------------------`), which AGENTS explicitly forbids.
- Exported functions: single-line `/** why */` JSDoc. Dashboard: almost none.
- Named `interface` above the function for props. Most files follow this; a few inline object-destructure param types (`SubagentCard`, `SubagentWorkerRow`, `RunStatusBadge`, `PRRow`, `FilterTab`) violate it.

### 3. `LogViewer.tsx` is 934 LOC — over the 800 hard ceiling

`AGENTS.md` → **"When Writing Code"**: *"File length: 200–400 LOC typical, 800 hard ceiling. When a file crosses 400, split along the pure/IO seam before adding more."* LogViewer contains an enormous pure section (grouping, JSON parsing, diff/file-list detection, time/duration/token formatters) glued onto eight React components. This is the canonical pure/IO split the backend uses in `core/pi/subagents.ts` / `core/pi/marker.ts`.

### 4. Four pages are in the 300–400 LOC "split soon" band

`TaskDetail` 350, `PrSessionDetail` 353, `PullRequests` 314, `Tasks` 310. All four inline sub-row components (`RunCard`, `PrSessionRow`, `PRRow`, `RepoRow`, `SessionStatusBadge`, `RunStatusBadge`) that belong in `components/`. Pages should own *data state and layout*; presentation lives in components.

### 5. Duplicated logic with no single source of truth

- **`formatDuration(start, end)`** is reimplemented in `PipelineProgress.tsx`, `TaskRow.tsx` (as `formatDurationBetween`), and `PrSessionDetail.tsx` (third copy, inline in the file). Three functions, three slightly different outputs. AGENTS `#no-hidden-duplication` applies.
- **Merge-live-logs pattern** (`useState<Map<string, LogEntry[]>>` → SSE listener pushes entries → merge with disk logs) appears in `Tasks.tsx`, `TaskDetail.tsx`, and `PrSessionDetail.tsx`. One hook.
- **Status badge** is implemented in `StatusBadge.tsx` *and* re-implemented inline in `PrSessionDetail.tsx` (`SessionStatusBadge`, `RunStatusBadge`) *and* inline-JSX in `PullRequests.tsx`. One component, one config table.
- **Three-state page guard** (loading+!data / error+!data / empty) is copy-pasted in all five pages with slightly different copy. One `<PageState>` or one hook.

### 6. Pure parsers not separated from IO

`AGENTS.md` → *"Pure parsers separated from IO. **The key testability pattern.** Extend everywhere. A file without a pure section that could have one is a smell."* Dashboard candidates:

- `LogViewer.tsx`: huge pure parser set buried inside a component.
- `lib/api.ts`: mixes types, the `request()` IO helper, and seven fetch wrappers. Split along IO seam.
- `lib/logs.ts`: already clean (pure). Add header docstring, keep.

### 7. Semantic token drift

`AGENTS.md` → *"Tailwind v4 semantic tokens only."* Dashboard mostly complies, but:

- `index.html` hardcodes `bg-[#050505]` on `<body>` instead of `bg-bg`.
- `Layout.tsx` uses `shadow-[0_4px_24px_rgba(0,0,0,0.5)]` inline.
- `Card.tsx` and `PrSessionDetail.tsx` both inline `shadow-[inset_2px_0_12px_rgba(212,160,23,0.04)]` for the "live" accent; should be a single `.live-glow` utility in `index.css`.

### 8. Inline magic numbers

`PREVIEW_LINES = 12` (local constant, fine), scroll threshold `40`, SSE retry `3000`, `SUBAGENT_OUTPUT_CAP` not surfaced on the client side, stagger delays enumerated manually up to `:nth-child(8)`. Move the ones used in multiple places into `lib/constants.ts` (frontend equivalent of `shared/config.ts` / `shared/limits.ts`).

---

## Target structure

```
dashboard/src/
  main.tsx
  App.tsx
  index.css
  shared.ts                    # NEW: re-exports from ../../src/shared/types.ts (narrow)

  lib/
    utils.ts                   # cn, shortId
    format.ts                  # NEW: formatDate, formatDuration, timeAgo, formatTokens, formatBytes
    constants.ts               # NEW: SSE_RETRY_MS, LOG_PREVIEW_LINES, LOG_SCROLL_EPSILON_PX
    log-grouping.ts            # NEW (pure): groupToolCalls, extractToolOutput, isRawToolJson, detectDiff, detectFileList, formatToolSummary
    logs.ts                    # existing: logEntryKey, sortLogEntries, mergeLogEntries
    task-grouping.ts           # NEW (pure): groupByDate
    api/
      client.ts                # NEW: request<T>(), base headers, error mapping
      tasks.ts                 # fetchTasks, fetchTask, fetchTaskLogs, fetchArtifact, retryTask, cancelTask, dismissTask
      prs.ts                   # fetchPRs
      pr-sessions.ts           # fetchPrSessions, fetchPrSessionDetail, fetchPrSessionLogs
      repos.ts                 # fetchRepos
      types.ts                 # Task, TaskWithStages, TaskStage, PR, PrSession, PrSessionRun, PrSessionWithRuns, Repo, LogEntry, StageLogs, TASK_KIND_CONFIG

  hooks/
    use-query.ts               # existing
    use-now.ts                 # existing
    use-sse.ts                 # existing
    use-live-logs.ts           # NEW: useLiveLogs(filter) -> Map<string, LogEntry[]>
    use-page-state.ts          # NEW: returns { state: "loading" | "error" | "empty" | "ready" } + render helper

  components/
    ErrorBoundary.tsx          # NEW: extracted from main.tsx
    Layout.tsx
    Card.tsx
    EmptyState.tsx
    SectionDivider.tsx
    StatusBadge.tsx            # expanded to cover session + run statuses
    Markdown.tsx
    PageState.tsx              # NEW: loading/error/empty guard wrapper
    PipelineProgress.tsx
    TaskRow.tsx
    rows/
      PrSessionRow.tsx         # NEW
      PrRow.tsx                # NEW
      RepoRow.tsx              # NEW
      RunCard.tsx              # NEW
    log-viewer/
      LogViewer.tsx            # top-level (~150 LOC)
      FilterBar.tsx            # NEW
      LogLine.tsx              # NEW
      ToolGroup.tsx            # NEW
      ToolOutput.tsx           # NEW (+ OutputLine)
      SubagentCard.tsx         # NEW (+ SubagentWorkerRow)
      constants.ts             # KIND_COLOR, TOOL_ICON, PREVIEW_LINES

  pages/
    Tasks.tsx                  # slimmed
    TaskDetail.tsx             # slimmed
    PullRequests.tsx           # slimmed
    PrSessionDetail.tsx        # slimmed
    Repos.tsx                  # mostly unchanged
```

Every new TS/TSX file opens with:

```ts
/** One-line role, why this file exists. */

import ...

// --- Public API ---
// --- Helpers ---
```

---

## Tasks

### Task 1: Shared types re-export

**Files:**
- Create: `dashboard/src/shared.ts`
- Modify: `dashboard/tsconfig.json` (ensure `"rootDir"` permissive / path alias for `../src/shared/types`)
- Modify: `dashboard/vite.config.ts` (add `@shared` alias pointing at `../src/shared`)

**Implementation:**

`dashboard/src/shared.ts`:

```ts
/** Narrow re-export of backend wire types so the dashboard never duplicates enums. */

export {
  TASK_KINDS,
  TASK_STATUSES,
  STAGE_STATUSES,
  LOG_ENTRY_KINDS,
  PR_SESSION_STATUSES,
  STAGE_NAMES,
} from "@shared/types";

export type {
  TaskKind,
  TaskStatus,
  StageStatus,
  LogEntryKind,
  PrSessionStatus,
  StageName,
} from "@shared/types";
```

Vite alias:

```ts
"@shared": path.resolve(__dirname, "../src/shared"),
```

`tsconfig.json` paths:

```json
"paths": {
  "@dashboard/*": ["src/*"],
  "@shared/*": ["../src/shared/*"]
}
```

**Verify:** `npm run build` compiles both tsc (backend) and vite (dashboard). Grep `dashboard/src` for redeclared `TaskKind`, `TaskStatus`, `LogEntryKind`, `StageStatus`, `PrSessionStatus`: zero hits (after Task 4).

---

### Task 2: Split `lib/api.ts` into `lib/api/` + `lib/api/types.ts`

**Files:**
- Create: `dashboard/src/lib/api/client.ts`, `types.ts`, `tasks.ts`, `prs.ts`, `pr-sessions.ts`, `repos.ts`, `index.ts` (barrel)
- Delete: `dashboard/src/lib/api.ts`
- Modify: every file that currently does `from "@dashboard/lib/api"` (stays the same path thanks to barrel).

**Implementation:**

`client.ts` — pure IO wrapper, ~25 LOC:

```ts
/** Shared fetch wrapper. Throws `Error(API <status>: <body>)` on non-2xx. */

const defaultHeaders: HeadersInit = { "Content-Type": "application/json" };

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...defaultHeaders, ...init?.headers } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function requestText(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.text();
}
```

`types.ts` — all wire types, imports enums from `@dashboard/shared`:

```ts
/** Dashboard-side wire types. Enums come from `@dashboard/shared` (single source of truth). */

import type { TaskKind, TaskStatus, StageStatus, LogEntryKind, PrSessionStatus } from "@dashboard/shared";

export interface Task { ... }
export interface TaskStage { ... }
export interface TaskWithStages extends Task { stages: TaskStage[]; }
// ...
```

`TASK_KIND_CONFIG` moves here and keys off `TaskKind` directly, so if a new kind is added to `TASK_KINDS` at the backend, TS errors immediately.

`tasks.ts`, `prs.ts`, `pr-sessions.ts`, `repos.ts` each own their endpoints.

`index.ts`:

```ts
export * from "./types.js";
export * from "./tasks.js";
export * from "./prs.js";
export * from "./pr-sessions.js";
export * from "./repos.js";
```

**Verify:** `npm run build` green. No behavioral change.

---

### Task 3: Extract shared formatters and constants

**Files:**
- Create: `dashboard/src/lib/format.ts`
- Create: `dashboard/src/lib/constants.ts`
- Modify: `dashboard/src/lib/utils.ts` (keep only `cn` and `shortId`)
- Modify: `PipelineProgress.tsx`, `TaskRow.tsx`, `PrSessionDetail.tsx` (remove local `formatDuration*`)
- Modify: `hooks/use-sse.ts` (use `SSE_RETRY_MS`)

**Implementation:**

`lib/format.ts`:

```ts
/** Pure time / number / byte formatters used in tables, logs, and detail pages. */

export function formatDate(iso: string): string { ... }

/** Seconds → "12s", "2m 30s", "1h 15m". */
export function formatDuration(startIso: string, endIso: string): string { ... }

/** Live-updating relative time. Caller passes `useNow()` as `nowMs`. */
export function timeAgo(iso: string, nowMs: number = Date.now()): string { ... }

/** 1234 → "1.2k". */
export function formatTokens(n: number): string { ... }
```

`lib/constants.ts`:

```ts
/** Frontend magic numbers. Keep inline constants only when they're truly local. */

export const SSE_RETRY_MS = 3_000;
export const NOW_TICK_MS = 15_000;
export const LOG_PREVIEW_LINES = 12;
export const LOG_SCROLL_EPSILON_PX = 40;
```

**Verify:** visual diff unchanged; `npm run build` green.

---

### Task 4: Drop duplicated enums from the old `lib/api.ts` (finished by Task 2) + delete `TASK_KIND_CONFIG` duplication

All enums now come via `@dashboard/shared`. `TASK_KIND_CONFIG` stays in `lib/api/types.ts` keyed by the imported `TaskKind`. Grep to confirm no `"coding_task" | "codebase_question" | "pr_review"` string unions remain anywhere in `dashboard/src`.

**Verify:** `rg '"coding_task"\s*\|\s*"codebase_question"' dashboard/src` → empty.

---

### Task 5: Split `LogViewer.tsx` along the pure/IO seam

**Files:**
- Create: `dashboard/src/lib/log-grouping.ts` (pure, ~150 LOC)
- Create: `dashboard/src/components/log-viewer/constants.ts`
- Create: `dashboard/src/components/log-viewer/LogViewer.tsx` (~120 LOC — container only)
- Create: `dashboard/src/components/log-viewer/FilterBar.tsx`
- Create: `dashboard/src/components/log-viewer/LogLine.tsx`
- Create: `dashboard/src/components/log-viewer/ToolGroup.tsx`
- Create: `dashboard/src/components/log-viewer/ToolOutput.tsx` (+ `OutputLine` colocated)
- Create: `dashboard/src/components/log-viewer/SubagentCard.tsx` (+ `SubagentWorkerRow`)
- Create: `dashboard/src/components/log-viewer/index.ts` (`export { LogViewer } from "./LogViewer.js";`)
- Delete: `dashboard/src/components/LogViewer.tsx`
- Modify: every import site (`pages/Tasks.tsx`, `pages/TaskDetail.tsx`, `pages/PrSessionDetail.tsx`).

**`lib/log-grouping.ts` contract** (pure, no React):

```ts
export type ProcessedItem = { type: "line"; entry: LogEntry } | ToolGroup;

export interface ToolGroup {
  type: "group";
  startSeq: number;
  toolName: string;
  toolCallId?: string;
  summary: string;
  entries: LogEntry[];
  ok: boolean;
  durationMs?: number;
  done: boolean;
}

/** Correlate tool_start / tool_update / tool_output / tool_end by toolCallId. */
export function groupToolCalls(entries: LogEntry[]): ProcessedItem[] { ... }

export function extractToolOutput(entries: LogEntry[]): string { ... }
export function isRawToolJson(text: string): boolean { ... }
export function formatToolSummary(toolName: string, raw: string): string { ... }
export function detectDiff(text: string): boolean { ... }
export function detectFileList(text: string): boolean { ... }
export function toolGroupKey(g: ToolGroup): string { ... }
```

These are the **first testable targets** the day Vitest lands (see backend AGENTS → "Testing").

**Verify:** run the app locally; a running task shows the same grouped tool calls, subagent cards, filter tabs. `npm run build` green. Every file under `log-viewer/` is <250 LOC.

---

### Task 6: Unify `StatusBadge` to cover task + session + run statuses

**Files:**
- Modify: `dashboard/src/components/StatusBadge.tsx`
- Modify: `pages/PrSessionDetail.tsx` (delete inline `SessionStatusBadge`, `RunStatusBadge`)
- Modify: `pages/PullRequests.tsx` (delete inline session status render)

**Implementation:**

```ts
/** Unified status pill. Accepts every runtime status we show in the UI. */

const STATUS_CONFIG: Record<string, { label: string; color: string; pulse?: boolean }> = {
  queued:    { label: "queued",    color: "text-text-dim" },
  running:   { label: "running",   color: "text-accent", pulse: true },
  complete:  { label: "complete",  color: "text-ok" },
  failed:    { label: "failed",    color: "text-fail" },
  cancelled: { label: "cancelled", color: "text-text-dim" },
  active:    { label: "watching",  color: "text-text-dim" },
  closed:    { label: "closed",    color: "text-text-void" },
};

export function StatusBadge({ status, className }: StatusBadgeProps) { ... }
```

`PrSessionDetail` passes `status={hasRunningRun ? "running" : session.status}`.

**Verify:** visual parity on PRs page + session detail.

---

### Task 7: Extract row components out of pages

**Files:**
- Create: `dashboard/src/components/rows/PrSessionRow.tsx`
- Create: `dashboard/src/components/rows/PrRow.tsx`
- Create: `dashboard/src/components/rows/RepoRow.tsx`
- Create: `dashboard/src/components/rows/RunCard.tsx`
- Modify: `pages/PullRequests.tsx` (delete `PrSessionRow`, `PRRow`)
- Modify: `pages/Repos.tsx` (delete `RepoRow`)
- Modify: `pages/PrSessionDetail.tsx` (delete `RunCard`)

Each row takes plain props, no data-fetching, no navigation (pages pass `onClick` handlers). No presentational change.

**Verify:** visual diff clean, `npm run build` green. Each page back under ~200 LOC.

---

### Task 8: `useLiveLogs` hook

**Files:**
- Create: `dashboard/src/hooks/use-live-logs.ts`
- Modify: `pages/Tasks.tsx`, `pages/TaskDetail.tsx`, `pages/PrSessionDetail.tsx`

**Implementation:**

```ts
/** Subscribe to SSE `log` events and bucket entries by a caller-supplied key. */

import { useRef, useState } from "react";
import { useSSE, type SSEEvent } from "./use-sse.js";
import type { LogEntry } from "@dashboard/lib/api";

interface UseLiveLogsOptions {
  match: (e: SSEEvent) => { key: string; entry: LogEntry } | null;
}

export function useLiveLogs({ match }: UseLiveLogsOptions): Map<string, LogEntry[]> {
  const [buckets, setBuckets] = useState<Map<string, LogEntry[]>>(new Map());
  const matchRef = useRef(match);
  matchRef.current = match;

  useSSE((event) => {
    const hit = matchRef.current(event);
    if (!hit) return;
    setBuckets((prev) => {
      const next = new Map(prev);
      const existing = next.get(hit.key) ?? [];
      next.set(hit.key, [...existing, hit.entry]);
      return next;
    });
  });

  return buckets;
}
```

Page usage (TaskDetail):

```ts
const liveLogs = useLiveLogs({
  match: (e) =>
    e.type === "log" && e.taskId === taskId
      ? { key: e.stage as string, entry: e.entry as LogEntry }
      : null,
});
```

**Verify:** live log streaming on an active task still works in all three pages.

---

### Task 9: `<PageState>` three-state guard

**Files:**
- Create: `dashboard/src/components/PageState.tsx`
- Modify: all five pages

**Implementation:**

```ts
/** Three-state guard per AGENTS: loading+!data, error+!data, empty, ready. */

interface PageStateProps<T> {
  data: T | null | undefined;
  loading: boolean;
  error: string | null;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}

export function PageState<T>(props: PageStateProps<T>): ReactNode { ... }
```

Pages become:

```tsx
<PageState data={task} loading={loading} error={error} onRetry={refetch}>
  {(task) => <>...</>}
</PageState>
```

**Verify:** each page still renders the three states. Error path shows retry. Empty path still uses `<EmptyState />`.

---

### Task 10: Normalize comment style, add file headers, apply docstring rules

**Files:** every file in `dashboard/src/`.

Mechanical pass:

- Replace every `/* ── Title ── */` and `// -------...-------` banner with `// --- Title ---`.
- Add a `/** role */` header to every file with ≥2 exports or a non-obvious role.
- Add single-line `/** why */` JSDoc above every exported function / component / type where the name doesn't already tell you everything.
- Delete restated-signature JSDoc (we have TS types).
- Delete inline `//` comments that restate code; keep only the ones flagging surprises.
- Rename inline param-destructure types to named `interface FooProps` above the function for: `FilterTab`, `LogLine`, `ToolGroup`, `ToolOutput`, `OutputLine`, `SubagentCard`, `SubagentWorkerRow`, `RunCard`, `PRRow`, `RepoRow`, `ErrorBoundary`.

**Verify:** `rg '/\* ── ' dashboard/src` → empty. `rg '// -{10,}' dashboard/src` → empty. `npm run build` green.

---

### Task 11: Extract `ErrorBoundary`, fix `index.html` semantic tokens

**Files:**
- Create: `dashboard/src/components/ErrorBoundary.tsx`
- Modify: `dashboard/src/main.tsx` (import from components)
- Modify: `dashboard/index.html` (`class="bg-[#050505] text-zinc-300"` → `class="bg-bg text-text"`)
- Modify: `dashboard/src/index.css` (add `.live-glow` utility)
- Modify: `components/Card.tsx` + any inline `shadow-[inset_2px_0_12px_rgba(212,160,23,0.04)]` sites → `live-glow`.

**Verify:** `rg 'bg-\[#' dashboard` → empty. `rg 'text-zinc-' dashboard` → empty. Visual parity.

---

### Task 12: Tighten pages

**Files:** `Tasks.tsx`, `TaskDetail.tsx`, `PrSessionDetail.tsx`, `PullRequests.tsx`.

With Tasks 2, 5, 6, 7, 8, 9 done, each page should already be <200 LOC. This task is the final sweep:

- Move `groupByDate` from `Tasks.tsx` to `lib/task-grouping.ts` (pure).
- Move `TRIGGER_LABELS` from `PrSessionDetail.tsx` to a colocated `RunCard.tsx` constant (it's only used there after Task 7).
- Move `HISTORY_FILTERS` from `Tasks.tsx` to `lib/constants.ts` if reused; otherwise keep local but `as const`.
- Make sure each page follows the shape:

  ```tsx
  /** Page role in one line. */

  // imports

  // --- Page ---
  export function Tasks() { ... }

  // --- Helpers ---
  function groupByDate(...) { ... }
  ```

**Verify:** every page <250 LOC, `npm run build` green, every route still works against `npm run dev`.

---

### Task 13: Update `docs/architecture.md` dashboard section

**Files:**
- Modify: `docs/architecture.md` (dashboard paragraph now covers `lib/api/`, `log-viewer/`, `rows/`, pure/IO seam, shared types re-export).

**Verify:** `docs/architecture.md` describes what the codebase is, not what it was. Run `rg 'lib/api\.ts' docs/` to confirm no stale references.

---

## Non-goals (deliberately excluded)

- No new runtime dependencies.
- No visual redesign. Every change is shape/organization.
- No route or API changes.
- No test files yet — Vitest is still not wired per backend AGENTS. Tasks 3/5/8 land the **pure** functions first so the day Vitest lands they're trivial to cover.
- No `createLogger` for the dashboard. Backend rule is backend-only; dashboard already has zero `console.log` usage.
- No switch to `@goodboy/shared` npm workspace package — narrow re-export via `@shared/*` path alias is the lighter option AGENTS explicitly allows.

---

## Size budget after landing

| File                                          | Before | After target |
|---                                            |---     |---           |
| `components/LogViewer.tsx`                    | 934    | deleted — 7 files, each <250 |
| `lib/api.ts`                                  | 227    | deleted — 7 files, each <80 |
| `pages/PrSessionDetail.tsx`                   | 353    | <150 |
| `pages/TaskDetail.tsx`                        | 350    | <180 |
| `pages/PullRequests.tsx`                      | 314    | <120 |
| `pages/Tasks.tsx`                             | 310    | <180 |
| Largest file in dashboard                     | 934    | <250 |

---

## Verification gate (run at the end, before handing the diff back)

1. `npm run build` exits 0.
2. `rg 'console\.' dashboard/src` → empty.
3. `rg 'export default' dashboard/src` → empty.
4. `rg '/\* ── ' dashboard/src` → empty (after Task 10).
5. `rg '// -{10,}' dashboard/src` → empty (after Task 10).
6. `wc -l dashboard/src/**/*.tsx dashboard/src/**/*.ts | sort -n | tail -5` → nothing over 400.
7. Manual smoke test against `npm run dev`: create a task via Telegram (or use a retry), watch it stream into the Tasks page live-logs, open TaskDetail, flip stage tabs, open an artifact, go to PRs, open a PR session.

---

Plan ready. Want me to start executing now (Task 1 first, one commit per task), or do you want to review first?
