# Goodboy — Agent Instructions

Operational policy for AI coding agents working in this repo. Keep it short, command-first, and verifiable. Deeper explanation lives in [`docs/architecture.md`](docs/architecture.md); this file is the contract.

> `CLAUDE.md` is a symlink to this file. One canonical source for every tool.

---

## Commands

```bash
npm run dev              # dashboard watcher + backend watcher in parallel
npm run dev:server       # backend only (tsx watch)
npm run dev:dashboard    # dashboard only (vite build --watch)
npm run build            # tsc (backend) + vite build (dashboard)
npm run start            # node dist/index.js

npm run db:generate      # generate migration SQL from schema changes
npm run db:migrate       # apply migrations to Neon (run from laptop, never from EC2)
npm run db:push          # push schema directly (bypass migrations)
npm run db:studio        # Drizzle Studio
```

Deploy is **one command on the EC2 host only**:

```bash
ssh goodboy && ./deploy-goodboy.sh   # pulls main, npm ci, npm run build, restarts systemd
```

DB migrations are **not** part of deploy. If a commit adds a file under `drizzle/`, run `npm run db:migrate` from your laptop **before** pushing the code that needs it.

---

## Stack (locked — do not swap without approval)

Grammy · Hono · Drizzle · Neon (HTTP driver) · Vite 8 · Tailwind v4 (Vite plugin, no `tailwind.config`) · pi RPC (`pi --mode rpc`).

---

## Project Map

```
src/
  index.ts      entry: Hono + Grammy bot + PR poller + shutdown
  telegram/     Grammy bot, intent classifier, handlers
  api/          Hono REST + SSE
  db/           Drizzle schema, repository, Neon singleton
  shared/       config, types, logger, events, repos, llm, agent-prompts (zero side effects)
  core/         infra primitives: stage.ts, cleanup.ts
  core/git/     git + GitHub helpers: worktree.ts, github.ts
  core/pi/      pi subprocess layer: spawn.ts, jsonl-reader.ts, session-file.ts, session-broadcast.ts
  pipelines/    one folder per task kind: coding/, question/, pr-review/, pr-session/
dashboard/src/  Vite React SPA
```

Dependency direction: `pipelines/` → `core/` → `shared/` → `db/`. Never reversed. `core/` never imports from `pipelines/`.

Full architecture walkthrough: [`docs/architecture.md`](docs/architecture.md).

---

## Definition of Done

A change is complete when **all** of these pass:

1. `npm run build` exits 0 (both `tsc` and `vite build`).
2. `npm test` exits 0 (all unit and integration tests pass).
3. Any touched pipeline has been manually run via `npm run dev` + Telegram, or dashboard-triggered retry, at least once.
4. New env vars are in `.env.example`.
5. Schema changes have a generated file in `drizzle/` and have been applied with `npm run db:migrate` before the code that reads them merges.
6. Commit messages use conventional prefixes (`feat:`, `fix:`, `refactor:`, `chore:`, `perf:`), one logical unit per commit.
7. No emojis. No `console.log`. No default exports. No mutated arrays or objects.

Never report "done" without running `npm run build && npm test`.

---

## When Writing Code

- File length: 200–400 LOC typical, 800 hard ceiling. When a file crosses 400, split along the pure/IO seam before adding more.
- Named exports only. No default exports.
- ESM: `.js` extensions on internal imports. `node:` protocol on Node builtins.
- Immutability: never mutate arrays or objects — always return new ones.
- Every backend file declares `const log = createLogger("<short-name>")` at the top. No `console.log` / `console.error`.
- Module-level singletons use `_` prefix (`_env`, `_db`), lazy init via a `loadX()` / `getX()` accessor, never exported.
- Magic numbers live in `shared/config.ts` or `shared/limits.ts`, never inline.
- Section files with two or more responsibilities using `// --- Tasks ---` style headers (see `db/repository.ts`, `api/index.ts`).

## When Touching Pipelines

- Every stage goes through `core/stage.ts#runStage`. Do not spawn `pi` directly from a pipeline.
- Inter-stage data passes through files in `artifacts/<taskId>/`, not return values. Each new artifact must be validated with `requireArtifact` before the next stage reads it.
- Only the planner loads the `pi-subagents` extension. Other stages run `--no-extensions` for reproducibility.
- Pipeline top-level catches all errors and maps them to `failTask`. Never leak a pipeline exception up to the bot handler.
- Telegram notifications are side effects: wrap with `notifyTelegram` (log-and-continue on failure).

## When Editing the Dashboard

- Props: named `interface` above the function. Defaults via destructuring.
- Styling: `cn()` from `lib/utils.ts` for every conditional class. No inline `style={}`.
- Pages own data state. Components are stateless or hold only UI-local state.
- Three-state guard on every page: `loading && !data` → spinner, `error && !data` → error + retry, empty → `<EmptyState />`.
- Tailwind v4 semantic tokens only: `bg-glass`, `text-accent`, `text-fail`, `text-warn`. Micro-scale text (`text-[8px]` to `text-sm`). Never `text-base`.
- Fonts: `font-display` for headings, `font-body` for prose, `font-mono` for IDs/status/logs.
- Shared wire types live in `src/shared/types.ts`. The dashboard consumes them via `@goodboy/shared` or a narrow re-export; never hand-duplicate `TaskStatus`, `TASK_KIND_CONFIG`, etc.

## When Working with the Database

1. Edit `src/db/schema.ts`.
2. Run `npm run db:generate`.
3. **Stop.** Do not apply. Wait for human review of the generated SQL.
4. After approval, a human runs `npm run db:migrate` from their laptop, then the dependent code may be merged.

All reads and writes go through `src/db/repository.ts`. All writes use `.returning()`. All reads filter by `instance = loadEnv().INSTANCE_ID`.

## When Committing

- Batch by feature or bug fix. One logical unit per commit.
- Conventional prefix required: `feat:`, `fix:`, `refactor:`, `chore:`, `perf:`.
- Run `npm run build` before committing.
- Update `.env.example` in the same commit that adds a new env var.

---

## Code Patterns (formalized — every new file follows these)

| Pattern | Lives in | Rule |
|---|---|---|
| Zod schema at every trust boundary | `shared/config.ts`, `telegram/intent-classifier.ts`, `shared/llm.ts#structuredOutput` | Every env var, LLM output, inbound API body, and SSE payload passes through Zod. No `JSON.parse(process.env.X)`, no `as SomeType`. |
| Discriminated unions over booleans/strings | `Intent`, `SSEEvent`, `FileEntry` | Anything with >2 states uses `{ type: "foo"; ... } \| { type: "bar"; ... }`. No parallel booleans (`isLoading`/`isError`). |
| `const X = [...] as const; type Y = (typeof X)[number]` | `shared/types.ts` | Single source of truth for enums. Same array drives the TS union, the Postgres `pgEnum`, and runtime `.includes()` checks. |
| Lazy singleton with `_` prefix | `shared/config.ts#_env`, `db/index.ts#_db` | Expensive one-time init hides behind `loadX()` / `getX()`. Importing the module has no side effects. |
| Section headers in multi-responsibility files | `db/repository.ts`, `api/index.ts`, `telegram/index.ts`, `core/stage.ts` | Use `// --- Name ---` blocks once a file holds two clear jobs. |
| `createLogger("module")` everywhere | all backend files | No `console.log` / `console.error`. |
| **Pure parsers separated from IO** | `core/git/github.ts`, `core/pi/session-file.ts`, `dashboard/src/components/log-viewer/helpers.ts` | **The key testability pattern. Extend everywhere.** Parsing / formatting / state-transition logic is exported as pure functions. IO (spawn, fetch, fs, exec, gh, db) wraps those pure functions. A file without a pure section that could have one is a smell. |

### Error policy

- Pure parsers: return `null` (or a `Result`-shaped union) for expected failures. Throw only for programmer bugs.
- IO adapters: throw typed errors; callers decide.
- Orchestrators (`pipelines/*`): catch at the top, map to `failTask`.
- Side-effect-only calls (Telegram, log persistence, poller ticks): log-and-continue.

### No hidden duplication

- PR/GitHub URL parsing → import `parseNwo` / `parsePrNumberFromUrl` / `parsePrIdentifier` from `core/git/github.ts`. Never re-implement the regex.
- DB reads → go through `db/repository.ts`, never touch `schema` from other modules.

### Docstrings and file shape

Every file follows the same rhythm so a skimmer can read the first 10 lines and know what it does.

- **File header.** Any file with ≥2 exports or a non-obvious role opens with a single `/** ... */` block (1-3 lines). It describes the module's *role*, not a list of exports. Trivial files (single export, self-evident from filename) skip it.
- **Section dividers.** `// --- Title ---` — short dashes, Title Case. Required once a file holds two distinct responsibilities. Never use long-bar separators (`// ----------------------`) or ASCII banners.
- **Exported functions and types.** Single-line `/** ... */` preferred, documenting the *why* — contract, invariant, surprise. Multi-line only when behavior is genuinely non-obvious. Never restate the signature.
- **Non-exported helpers.** Docstring only when behavior is non-obvious. Trust good names.
- **Never use** `@param`, `@returns`, `@throws`, `@example`. TypeScript types carry that; JSDoc tags duplicate them and rot.
- **Inline `//` comments** only for surprising logic. Prefer a named constant (`const POLL_INTERVAL_MS = 3 * 60 * 1000`) over `// 3 minutes`.

Target shape:

```ts
/**
 * Per-toolCallId throttle for high-frequency tool_execution_update events.
 * Keeps the dashboard and disk from getting swamped by parallel subagents.
 */

import { ... } from "...";

const THROTTLE_MS = 250;

// --- Public API ---

/** Create a coalescer scoped to one pi session. */
export function createSubagentCoalescer(...): Coalescer { ... }

// --- Helpers ---

function mergeProgress(...) { ... }
```

---

## Escalation Rules

**Ask a human before:**
- Adding a new pipeline stage or task kind.
- Adding a new top-level directory under `src/`.
- Swapping or removing any locked stack entry.
- Introducing a DI framework, state manager, or ORM other than Drizzle.
- Applying a DB migration in production.

**When blocked:**
- If `npm run build` fails after 2 targeted attempts: stop, report the failing file and error verbatim.
- If a test/manual-run reveals a regression: stop, do not paper over with try/catch.
- If a dependency is missing: check `package.json` first, then ask before installing.

**Never:**
- Commit emojis, `console.log`, default exports, or mutated objects.
- Bypass `db/repository.ts` to read or write the database directly.
- Spawn `pi` outside `core/stage.ts#runStage`.
- Apply a migration as part of deploy.
- Put secrets in `AGENTS.md`, logs, or committed files.
- Force-push to `main`.

---

## Testing

Vitest is wired via `vitest.config.ts` (single `node` environment). All test files live under `tests/` mirroring the source layout — `tests/unit/**` for unit tests, `tests/integration/**` for integration tests. Source files under `src/` and `dashboard/src/` stay free of `*.test.ts` files. Tests import production code via the `@src` and `@dashboard` path aliases. Run the suite with `npm test`.

Scope covered by tests:
- Pure functions: `core/git/github.ts` parsers, `core/pi/session-file.ts` read + path helpers, `core/git/worktree.ts#generateBranchName`, `shared/repos.ts`, `shared/config.ts` env schema, `shared/events.ts`, dashboard `log-viewer/helpers.ts`, `lib/format.ts`, `lib/task-grouping.ts`, `lib/utils.ts`.
- IO adapters with mocked boundaries: `core/git/github.ts` gh-CLI wrappers (`vi.mock execFile`), `shared/llm.ts` (msw on the Fireworks endpoint), `telegram/intent-classifier.ts` + `telegram/handlers.ts`, `core/pi/session-file.ts#watchSessionFile` (real IO in `os.tmpdir()`), `core/cleanup.ts`.
- HTTP + SSE: `api/index.ts` via `app.fetch(new Request(...))` with `db/repository`, pipelines, and `cleanup.ts` mocked.

Scope **not** covered (deliberately): `core/pi/**`, `core/stage.ts`, `pipelines/**/pipeline.ts`, PR-session orchestration, `db/repository.ts`, dashboard React components and hooks. Verify those via `npm run dev` + real Telegram / dashboard flows before committing.

---

## Environment

Keep `.env.example` in sync on every change. Required keys:

- `INSTANCE_ID` — prod/dev isolation; every DB query filters by this.
- `PI_MODEL` — default model for all stages.
- `PI_MODEL_{PLANNER,IMPLEMENTER,REVIEWER,PR_CREATOR,REVISION}` — optional per-stage overrides.
- `REGISTERED_REPOS` — JSON string, Zod-validated at startup.
- `FIREWORKS_API_KEY` — used by `shared/llm.ts` (intent classifier, branch-name slugging).
- `GH_TOKEN` — used by `gh` CLI in `core/git/github.ts` and `core/cleanup.ts`.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`, `DATABASE_URL`.
