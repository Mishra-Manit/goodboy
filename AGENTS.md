# Goodboy

Background coding agent system controlled via Telegram. You send it a task, it runs through a pi RPC pipeline (Planner > Implementer > Reviewer > PR Creator), and opens a PR autonomously. A React dashboard provides real-time visibility.

MVP stage, evolving to a full product.

## Commands

```bash
npm run dev          # Start dev server (builds dashboard + runs backend)
npm run build        # Production build
npm run db:generate  # Generate migration SQL from schema changes
npm run db:studio    # Open Drizzle Studio
```

Deploy:
```bash
ssh goodboy
bash deploy.sh       # Pushes, pulls on EC2, installs, builds, restarts systemd
```

Always commit before deploying.

## Stack (locked -- do not swap)

- **Grammy** -- Telegram bot
- **Hono** -- HTTP server + API
- **Drizzle** -- ORM
- **Neon** -- Hosted Postgres
- **Vite** -- Dashboard bundling
- **pi RPC** -- Agent orchestration (`pi --mode rpc`, JSON over stdin/stdout)

Pi RPC docs: `~/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/README.md`

## Project Structure

```
src/
  bot/            Telegram bot (Grammy)
  orchestrator/   Pipeline, pi RPC, worktrees, prompts, logs
  api/            Hono API routes
  db/             Drizzle schema, queries, connection
  shared/         Config, types, logger, events, repos
dashboard/
  src/
    components/   Reusable UI components
    pages/        Route-level pages
    hooks/        Custom React hooks
    lib/          Utils, API client
```

## Code Style

- Never over-engineer. Simple, readable, enjoyable-to-read code.
- Follow existing patterns in the codebase. When unsure, match what's already there.
- Many small files over few large ones (200-400 lines typical, 800 max).
- Immutability -- never mutate objects or arrays, always return new ones.
- Use `createLogger("module-name")` everywhere. No `console.log`.
- Log errors before rethrowing. Never swallow errors silently.
- No emojis anywhere.

## Database Workflow

1. Edit `src/db/schema.ts`
2. Run `npm run db:generate` to create migration SQL in `drizzle/`
3. **STOP** -- do not apply the migration. Wait for human review.

Never push schema changes directly to Neon without review.

## Testing

No test framework yet. Verify changes manually by running `npm run dev` and testing the affected flows. Always test before committing.

## Commits

Conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`, `perf:`

Batch changes by feature or bug fix. One logical unit per commit.

## Ask First

- Adding new pipeline stages (Planner, Implementer, Reviewer, PR Creator)
- Adding new top-level directories under `src/`

## Environment

Keep `.env.example` in sync whenever a new env var is added.
