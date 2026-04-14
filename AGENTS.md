# Goodboy

Background coding agent system controlled via Telegram. Send a task, it runs through a pi RPC pipeline (Planner > Implementer > Reviewer > PR Creator), and opens a PR autonomously. A React dashboard provides real-time visibility.

MVP stage, evolving to a full product.

## Commands

```bash
npm run dev              # Runs dashboard watcher + backend watcher in parallel
npm run dev:server       # Backend only (tsx watch)
npm run dev:dashboard    # Dashboard only (vite build --watch, no HMR)
npm run build            # Production: tsc (backend) + vite build (dashboard)
npm run start            # Run compiled backend: node dist/index.js
npm run db:generate      # Generate migration SQL from schema changes
npm run db:migrate       # Apply migrations to Neon (runs automatically on deploy)
npm run db:push          # Push schema directly to Neon (bypass migrations)
npm run db:studio        # Open Drizzle Studio
```

Deploy (must be on `main` branch):
```bash
bash deploy.sh
# Pushes to origin, SSHs into EC2, pulls, installs, builds, migrates, restarts
```

Deploy runs `npm run db:migrate` automatically. Always commit before deploying.

## Stack (locked -- do not swap)

- **Grammy** -- Telegram bot
- **Hono** -- HTTP server + API
- **Drizzle** -- ORM (Neon HTTP driver)
- **Neon** -- Hosted Postgres
- **Vite 8** -- Dashboard bundling (Tailwind v4 as Vite plugin, no tailwind.config)
- **pi RPC** -- Agent orchestration (`pi --mode rpc`, JSON over stdin/stdout)

Pi RPC docs: `~/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/README.md`

## Project Structure

```
src/
  index.ts          Entry point: Hono app + Grammy bot + shutdown hooks
  bot/              Telegram bot (Grammy), single-user auth, conversation tracking
  orchestrator/     Pipeline, pi RPC, worktrees, prompts, logs
  api/              Hono REST routes + SSE endpoint
  db/               Drizzle schema, queries, Neon connection singleton
  shared/           Config, types, logger, events, repos (zero side effects)
dashboard/
  src/
    components/     Reusable UI components (Card, StatusBadge, LogViewer, etc.)
    pages/          Route-level pages (Tasks, TaskDetail, PullRequests, Repos)
    hooks/          Custom hooks (useQuery, useSSE)
    lib/            Utils (cn, timeAgo), API client + types
```

Two separate build pipelines share the same `node_modules`:
- Backend: `tsc` compiles `src/` to `dist/`
- Dashboard: Vite bundles `dashboard/src/` to `dashboard/dist/`

Two separate `tsconfig.json` files -- backend excludes dashboard, dashboard is `noEmit` (Vite handles transpilation).

## Code Style

- Never over-engineer. Simple, readable, enjoyable-to-read code.
- Follow existing patterns in the codebase. When unsure, match what is already there.
- Many small files over few large ones (200-400 lines typical, 800 max).
- Immutability -- never mutate objects or arrays, always return new ones.
- Named exports everywhere. No default exports.
- ESM: use `.js` extensions on all internal imports. Use `node:` protocol for Node builtins.
- Module-level singletons use `_` prefix (`_env`, `_db`) and are initialized lazily, not exported.
- Use `createLogger("module-name")` in all backend code. No `console.log`.
- Log errors before rethrowing. Never swallow errors silently.
- No emojis anywhere.

## Dashboard Conventions

- Props: named interface defined above the function, defaults via destructuring.
- Styling: use `cn()` from `lib/utils.ts` for all conditional class merging. No inline `style={}`.
- Pages own all data state. Components are stateless or manage only UI-local state.
- Three-state loading guard: `loading && !data` -> spinner, `error && !data` -> error + retry, empty -> EmptyState.
- Tailwind v4 with `@theme` tokens in `index.css`. Use semantic token names (`bg-glass`, `text-accent`, `text-fail`, etc.).
- Fonts: `font-display` (Space Grotesk) for headings, `font-body` (Inter) for prose, `font-mono` (JetBrains Mono) for IDs/status/logs.
- Text sizes are micro-scaled (`text-[8px]` to `text-sm`). Never use `text-base`.
- Path alias: `@dashboard/*` maps to `dashboard/src/*`.

## Database Workflow

1. Edit `src/db/schema.ts`
2. Run `npm run db:generate` to create migration SQL in `drizzle/`
3. **STOP** -- do not apply the migration. Wait for human review.

All queries go through `src/db/queries.ts`. All writes use `.returning()`. All reads filter by `instance = INSTANCE_ID`.

## Pipeline

Four stages run sequentially per task: **planner** > **implementer** > **reviewer** > **pr_creator**.

Inter-stage data passes through `artifacts/<taskId>/`:
- `plan.md` (planner writes, all others read)
- `implementation-summary.md` (implementer writes, reviewer + pr_creator read)
- `review.md` (reviewer writes, pr_creator reads)

Each stage spawns a pi RPC subprocess in the task's git worktree. The planner can ask clarifying questions via Telegram before proceeding.

## Testing

No test framework yet. Verify changes manually by running `npm run dev` and testing the affected flows. Always test before committing.

## Commits

Conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`, `perf:`

Batch changes by feature or bug fix. One logical unit per commit.

## Ask First

- Adding new pipeline stages
- Adding new top-level directories under `src/`

## Environment

Keep `.env.example` in sync whenever a new env var is added. Key vars: `INSTANCE_ID` (prod/dev isolation), `PI_MODEL` (controls which AI model all pipeline stages use), `REGISTERED_REPOS` (JSON string parsed at runtime).
