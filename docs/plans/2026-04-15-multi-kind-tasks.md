# Multi-Kind Task Support Implementation Plan

**Goal:** Support three distinct task kinds (coding task, codebase question, PR review) with per-kind orchestration, shared infrastructure, and dashboard rendering.

**Approach:** Add a `task.kind` discriminator column, extract shared orchestrator code to root-level files, create per-kind subdirectories (`dev-task/`, `questions/`, `pr-review/`) under `src/orchestrator/`, migrate task statuses to a generic lifecycle model (`queued | running | complete | failed | cancelled`), and branch the dashboard on `kind` for detail views. Questions run directly in the synced main repo with strict read-only prompts. PR review checks out the PR branch in a worktree.

**Stack:** Drizzle/Neon (schema + migration), Grammy (bot routing), pi RPC (agent sessions), Hono (API), React + Tailwind (dashboard)

---

### Task 1: Create the task-kinds config module

**Files:**
- Create: `src/shared/task-kinds.ts`

**Implementation:**

```typescript
import type { StageName, TaskKind } from "./types.js";

export interface TaskKindConfig {
  readonly label: string;
  readonly stages: readonly StageName[];
  readonly artifacts: readonly { key: string; label: string }[];
}

export const TASK_KIND_CONFIG: Record<TaskKind, TaskKindConfig> = {
  coding_task: {
    label: "coding task",
    stages: ["planner", "implementer", "reviewer", "pr_creator"],
    artifacts: [
      { key: "plan.md", label: "plan" },
      { key: "implementation-summary.md", label: "summary" },
      { key: "review.md", label: "review" },
    ],
  },
  codebase_question: {
    label: "question",
    stages: ["answering"],
    artifacts: [{ key: "answer.md", label: "answer" }],
  },
  pr_review: {
    label: "PR review",
    stages: ["pr_reviewing"],
    artifacts: [{ key: "pr-review.md", label: "review" }],
  },
};
```

**Verify:** `npx tsc --noEmit` passes (will fail until Task 2 adds the types — that's fine, they go together).

**Commit:** `feat: add task-kinds config module`

---

### Task 2: Extend the type system

**Files:**
- Modify: `src/shared/types.ts`

**Implementation:**

Add `TaskKind` type and extend `STAGE_NAMES` and `TASK_STATUSES`:

```typescript
// Task kinds
export const TASK_KINDS = ["coding_task", "codebase_question", "pr_review"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

// Task statuses — generic lifecycle (replace current pipeline-specific set)
export const TASK_STATUSES = [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
] as const;

// Stage names — union across all kinds
export const STAGE_NAMES = [
  "planner",
  "implementer",
  "reviewer",
  "pr_creator",
  "revision",
  "answering",
  "pr_reviewing",
] as const;
```

Remove `STAGE_TO_STATUS` (the mapping from stage to pipeline-specific status). It's no longer needed — all active stages correspond to `task.status = "running"`.

Update `SSEEvent` to include `kind` on task_update:

```typescript
export type SSEEvent =
  | { type: "task_update"; taskId: string; status: TaskStatus; kind?: TaskKind }
  | { type: "stage_update"; taskId: string; stage: StageName; status: StageStatus }
  | { type: "log"; taskId: string; stage: StageName; entry: LogEntry }
  | { type: "pr_update"; taskId: string; prUrl: string };
```

**Verify:** `npx tsc --noEmit` — will surface every callsite that references removed `STAGE_TO_STATUS` or old status values. Fix those in subsequent tasks.

**Commit:** `refactor: generalize type system for multi-kind tasks`

---

### Task 3: DB schema migration

**Files:**
- Modify: `src/db/schema.ts`
- Generated: `drizzle/XXXX-*.sql` (via `npm run db:generate`)

**Implementation:**

```typescript
import { pgTable, text, timestamp, integer, uuid, pgEnum } from "drizzle-orm/pg-core";
import { TASK_STATUSES, STAGE_STATUSES, STAGE_NAMES, TASK_KINDS } from "../shared/types.js";

export const taskKindEnum = pgEnum("task_kind", [...TASK_KINDS] as [string, ...string[]]);
export const taskStatusEnum = pgEnum("task_status", [...TASK_STATUSES] as [string, ...string[]]);
export const stageStatusEnum = pgEnum("stage_status", [...STAGE_STATUSES] as [string, ...string[]]);
export const stageNameEnum = pgEnum("stage_name", [...STAGE_NAMES] as [string, ...string[]]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  repo: text("repo").notNull(),
  kind: taskKindEnum("kind").notNull().default("coding_task"),
  description: text("description").notNull(),
  status: taskStatusEnum("status").notNull().default("queued"),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  prIdentifier: text("pr_identifier"), // for pr_review kind: the PR being reviewed
  error: text("error"),
  instance: text("instance").notNull(),
  telegramChatId: text("telegram_chat_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

// taskStages unchanged except stageNameEnum now includes new values
export const taskStages = pgTable("task_stages", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id),
  stage: stageNameEnum("stage").notNull(),
  status: stageStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  piSessionId: text("pi_session_id"),
  error: text("error"),
});
```

The generated migration SQL needs to handle the enum value changes. Drizzle may not auto-generate ALTER TYPE for pgEnums cleanly. The migration should:

1. Add new enum values: `ALTER TYPE stage_name ADD VALUE 'answering'; ALTER TYPE stage_name ADD VALUE 'pr_reviewing';`
2. Add `task_kind` enum and `kind` column
3. Add `pr_identifier` column
4. Migrate existing status values: `UPDATE tasks SET status = 'running' WHERE status IN ('planning', 'implementing', 'reviewing', 'creating_pr', 'revision');`
5. Remove old enum values (requires recreating the enum or leaving them — leaving them is simpler for MVP)

Run `npm run db:generate`, then inspect and hand-edit the migration SQL if needed.

**Verify:** Inspect the generated SQL in `drizzle/`. Do NOT apply — wait for review.

**Commit:** `feat: add task kind and generic status to schema`

---

### Task 4: Update queries.ts for kind support

**Files:**
- Modify: `src/db/queries.ts`

**Implementation:**

Update `createTask` to accept `kind`:

```typescript
export async function createTask(data: {
  repo: string;
  kind: TaskKind;
  description: string;
  telegramChatId: string;
  prIdentifier?: string;
}): Promise<Task> {
  const db = getDb();
  const [task] = await db
    .insert(schema.tasks)
    .values({
      repo: data.repo,
      kind: data.kind,
      description: data.description,
      telegramChatId: data.telegramChatId,
      prIdentifier: data.prIdentifier ?? null,
      instance: loadEnv().INSTANCE_ID,
    })
    .returning();
  return task;
}
```

Update the `TaskStatus` import to use the new generic set. Update `updateTask` partial type — remove `status` values that no longer exist. Add `kind` to the `listTasks` filter options:

```typescript
export async function listTasks(filters?: {
  status?: TaskStatus;
  repo?: string;
  kind?: TaskKind;
}): Promise<Task[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.instance, loadEnv().INSTANCE_ID),
      filters?.status ? eq(schema.tasks.status, filters.status) : undefined,
      filters?.repo ? eq(schema.tasks.repo, filters.repo) : undefined,
      filters?.kind ? eq(schema.tasks.kind, filters.kind) : undefined,
    ))
    .orderBy(desc(schema.tasks.createdAt));
}
```

**Verify:** `npx tsc --noEmit`

**Commit:** `feat: extend queries for task kind and generic status`

---

### Task 5: Extract shared orchestrator infrastructure

**Files:**
- Create: `src/orchestrator/shared.ts`
- Modify: `src/orchestrator/index.ts`

**Implementation:**

Move from current `pipeline.ts` into `shared.ts`:

```typescript
import { createLogger } from "../shared/logger.js";
import { emit } from "../shared/events.js";
import { config } from "../shared/config.js";
import * as queries from "../db/queries.js";
import { spawnPiSession, type PiSession } from "./pi-rpc.js";
import { appendLogEntry, makeEntry, resetSeq } from "./logs.js";
import type { StageName, TaskStatus, LogEntryKind } from "../shared/types.js";
import type { Task } from "../db/queries.js";

const log = createLogger("orchestrator");

// --- Concurrency gate ---

const waitingForSlot: Array<() => void> = [];
let runningCount = 0;

export async function acquireSlot(): Promise<void> {
  if (runningCount < config.maxParallelTasks) {
    runningCount++;
    return;
  }
  await new Promise<void>((resolve) => {
    waitingForSlot.push(resolve);
  });
  runningCount++;
}

export function releaseSlot(): void {
  runningCount--;
  const next = waitingForSlot.shift();
  if (next) next();
}

// --- Session management ---

const activeSessions = new Map<string, PiSession>();

export function setActiveSession(taskId: string, session: PiSession): void {
  activeSessions.set(taskId, session);
}

export function clearActiveSession(taskId: string): void {
  activeSessions.delete(taskId);
}

export function cancelTask(taskId: string): boolean {
  const session = activeSessions.get(taskId);
  if (session) {
    session.kill();
    activeSessions.delete(taskId);
  }
  const pending = pendingReplies.get(taskId);
  if (pending) {
    pending.reject(new Error("Task cancelled"));
    pendingReplies.delete(taskId);
  }
  return !!(session || pending);
}

// --- Reply waiting (for planner conversation loop) ---

const pendingReplies = new Map<string, {
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
}>();

const REPLY_TIMEOUT_MS = 60 * 60 * 1000;

export function deliverReply(taskId: string, reply: string): boolean {
  const pending = pendingReplies.get(taskId);
  if (pending) {
    pending.resolve(reply);
    pendingReplies.delete(taskId);
    return true;
  }
  return false;
}

export function waitForReply(taskId: string): Promise<string> {
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

// --- Telegram ---

export type SendTelegram = (chatId: string, text: string) => Promise<void>;

export async function notifyTelegram(
  sendTelegram: SendTelegram,
  chatId: string | null,
  text: string,
): Promise<void> {
  if (!chatId) return;
  try {
    await sendTelegram(chatId, text);
  } catch (err) {
    log.warn(`Failed to send Telegram message: ${String(err)}`);
  }
}

// --- Task failure ---

export async function failTask(
  taskId: string,
  error: string,
  sendTelegram: SendTelegram,
  chatId: string | null,
): Promise<void> {
  log.error(`Task ${taskId} failed: ${error}`);
  await queries.updateTask(taskId, { status: "failed", error });
  emit({ type: "task_update", taskId, status: "failed" });
  await notifyTelegram(sendTelegram, chatId, `Task failed: ${error}`);
}

// --- Timeout ---

const STAGE_TIMEOUT_MS = 30 * 60 * 1000;

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 60000}min`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

export { STAGE_TIMEOUT_MS };

// --- Generic stage runner ---

export async function runStage(options: {
  taskId: string;
  stage: StageName;
  cwd: string;
  systemPrompt: string;
  initialPrompt: string;
  model: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
  stageLabel: string;
}): Promise<{ marker: import("../shared/types.js").PiOutputMarker | null; fullOutput: string }> {
  const { taskId, stage, cwd, systemPrompt, initialPrompt, model, sendTelegram, chatId, stageLabel } = options;

  await queries.updateTask(taskId, { status: "running" });
  emit({ type: "task_update", taskId, status: "running" });

  const stageRecord = await queries.createTaskStage({ taskId, stage });
  emit({ type: "stage_update", taskId, stage, status: "running" });

  log.info(`Starting stage ${stage} for task ${taskId}`);
  await notifyTelegram(sendTelegram, chatId, `Stage started: ${stageLabel}.`);

  resetSeq(taskId, stage);

  const session = spawnPiSession({
    id: `${taskId}-${stage}`,
    cwd,
    systemPrompt,
    model,
    onLog: (kind: LogEntryKind, text: string, meta?: Record<string, unknown>) => {
      const entry = makeEntry(taskId, stage, kind, text, meta);
      emit({ type: "log", taskId, stage, entry });
      appendLogEntry(taskId, stage, entry).catch((err) => {
        log.warn(`Failed to persist log entry: ${err}`);
      });
    },
  });

  setActiveSession(taskId, session);
  session.sendPrompt(initialPrompt);

  try {
    const result = await withTimeout(session.waitForCompletion(), STAGE_TIMEOUT_MS, `Stage ${stage}`);
    session.kill();
    clearActiveSession(taskId);

    await queries.updateTaskStage(stageRecord.id, {
      status: "complete",
      completedAt: new Date(),
    });
    emit({ type: "stage_update", taskId, stage, status: "complete" });
    await notifyTelegram(sendTelegram, chatId, `Stage complete: ${stageLabel}.`);

    log.info(`Stage ${stage} complete for task ${taskId}`);
    return result;
  } catch (err) {
    session.kill();
    clearActiveSession(taskId);
    await queries.updateTaskStage(stageRecord.id, { status: "failed" }).catch(() => {});
    emit({ type: "stage_update", taskId, stage, status: "failed" });
    throw err;
  }
}
```

Update `src/orchestrator/index.ts` to re-export from shared:

```typescript
export { cancelTask, deliverReply } from "./shared.js";
export type { SendTelegram } from "./shared.js";
export { readTaskLogs, readStageEntries } from "./logs.js";
// Pipeline exports added in later tasks
```

**Verify:** `npx tsc --noEmit`

**Commit:** `refactor: extract shared orchestrator infrastructure`

---

### Task 6: Move coding task pipeline into dev-task/

**Files:**
- Create: `src/orchestrator/dev-task/prompts.ts`
- Create: `src/orchestrator/dev-task/pipeline.ts`
- Create: `src/orchestrator/dev-task/index.ts`
- Modify: `src/orchestrator/prompts.ts` (keep only shared fragments)
- Delete: `src/orchestrator/pipeline.ts` (moved)
- Modify: `src/orchestrator/index.ts`

**Implementation:**

`src/orchestrator/prompts.ts` — keep only shared fragments:

```typescript
export const SHARED_RULES = `
CRITICAL RULES:
- Do NOT shell out to other AI tools (claude, copilot, cursor, aider, etc.)
- Do NOT read or follow CLAUDE.md, AGENTS.md, or any agent config files in the repo
- Use only the built-in read, write, edit, and bash tools to do your work
- Stay focused on the task
`;

export const WORKTREE_CONTEXT = `
ENVIRONMENT CONTEXT:
You are working in a git worktree -- a fresh checkout of the repo with NO installed
dependencies (no node_modules, no venv, no pip packages, no build artifacts).
...
`;

export interface WorktreeEnv {
  envNotes?: string;
}

export function worktreeBlock(env?: WorktreeEnv): string {
  let block = WORKTREE_CONTEXT;
  if (env?.envNotes) {
    block += `\nADDITIONAL ENVIRONMENT NOTES:\n${env.envNotes}\n`;
  }
  return block;
}
```

`src/orchestrator/dev-task/prompts.ts` — import shared fragments, export all five coding prompts (plannerPrompt, implementerPrompt, reviewerPrompt, prCreatorPrompt, revisionPrompt). Same content as current `prompts.ts` but importing `SHARED_RULES`, `worktreeBlock` from `../prompts.js`.

`src/orchestrator/dev-task/pipeline.ts` — refactored `runPipeline()`:
- Import `acquireSlot`, `releaseSlot`, `failTask`, `notifyTelegram`, `runStage`, `setActiveSession`, `clearActiveSession`, `waitForReply`, `withTimeout`, `STAGE_TIMEOUT_MS` from `../shared.js`
- Import prompts from `./prompts.js`
- The planner conversation loop (needs_input / ready) is specific to coding tasks, so it stays here. Override the generic `runStage` for the planner stage only — call `runStage` for implementer/reviewer/pr_creator, but handle planner manually since it has the Q&A loop.
- Keep `requireArtifact`, `extractPrUrl`, `extractPrNumber` as local helpers.
- Keep `getModelForStage` here (coding-task-specific model overrides).

`src/orchestrator/dev-task/index.ts`:

```typescript
export { runPipeline } from "./pipeline.js";
```

`src/orchestrator/index.ts`:

```typescript
export { cancelTask, deliverReply } from "./shared.js";
export type { SendTelegram } from "./shared.js";
export { readTaskLogs, readStageEntries } from "./logs.js";
export { runPipeline } from "./dev-task/index.js";
```

**Verify:** `npm run dev` — trigger a coding task through Telegram, confirm the full pipeline still works end-to-end (plan → implement → review → PR).

**Commit:** `refactor: move coding task pipeline into dev-task/`

---

### Task 7: Build the question orchestrator

**Files:**
- Create: `src/orchestrator/questions/prompts.ts`
- Create: `src/orchestrator/questions/pipeline.ts`
- Create: `src/orchestrator/questions/index.ts`
- Modify: `src/orchestrator/index.ts`

**Implementation:**

`src/orchestrator/questions/prompts.ts`:

```typescript
import { SHARED_RULES } from "../prompts.js";

export function questionSystemPrompt(question: string, artifactsDir: string): string {
  return `You are answering a question about a codebase. You have READ-ONLY access.
${SHARED_RULES}
READ-ONLY RULES:
- Use read and bash (grep, find, ls, head, tail, wc) to explore the codebase
- Do NOT use write or edit tools EXCEPT to write the final answer file
- Do NOT run git commit, git checkout, git reset, or any git write operation
- Do NOT install dependencies, run builds, or execute application code
- Do NOT modify any file in the repository

QUESTION: ${question}

YOUR JOB:
1. Explore the codebase to find the answer
2. Cite exact file paths and line numbers for every claim
3. If you are uncertain about something, say so explicitly
4. Write your answer to: ${artifactsDir}/answer.md

The answer.md file should be well-structured markdown with:
- A direct answer to the question
- File path citations (e.g. \`src/foo/bar.ts:42\`)
- Code snippets where helpful

After writing answer.md, end your output with:
  {"status": "complete"}`;
}

export function questionInitialPrompt(question: string, artifactsDir: string): string {
  return `Answer this question about the codebase:\n\n${question}\n\nExplore the code, then write your answer to ${artifactsDir}/answer.md.`;
}
```

`src/orchestrator/questions/pipeline.ts`:

```typescript
import path from "node:path";
import { mkdir, rm, readFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config, loadEnv } from "../../shared/config.js";
import { emit } from "../../shared/events.js";
import { cleanupSeqCounters } from "../logs.js";
import { getRepo } from "../../shared/repos.js";
import { syncRepo } from "../worktree.js";
import * as queries from "../../db/queries.js";
import {
  acquireSlot,
  releaseSlot,
  failTask,
  notifyTelegram,
  runStage,
  clearActiveSession,
  type SendTelegram,
} from "../shared.js";
import { questionSystemPrompt, questionInitialPrompt } from "./prompts.js";

const log = createLogger("question");

export async function runQuestion(
  taskId: string,
  sendTelegram: SendTelegram,
): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) {
    log.error(`Task ${taskId} not found`);
    return;
  }

  const repo = getRepo(task.repo);
  if (!repo) {
    await failTask(taskId, `Repo '${task.repo}' not found`, sendTelegram, task.telegramChatId);
    return;
  }

  await acquireSlot();
  log.info(`Acquired slot for question ${taskId}`);

  await notifyTelegram(
    sendTelegram,
    task.telegramChatId,
    `Answering question for ${task.repo}...\n\n${task.description}`,
  );

  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  try {
    await syncRepo(repo.localPath);
  } catch (err) {
    releaseSlot();
    await failTask(taskId, `Failed to sync repo: ${err}`, sendTelegram, task.telegramChatId);
    return;
  }

  const env = loadEnv();

  try {
    await runStage({
      taskId,
      stage: "answering",
      cwd: repo.localPath,
      systemPrompt: questionSystemPrompt(task.description, path.resolve(artifactsDir)),
      initialPrompt: questionInitialPrompt(task.description, path.resolve(artifactsDir)),
      model: env.PI_MODEL,
      sendTelegram,
      chatId: task.telegramChatId,
      stageLabel: "Answering",
    });

    // Read answer and send via Telegram
    try {
      const answer = await readFile(path.join(artifactsDir, "answer.md"), "utf-8");
      const truncated = answer.length > 4000
        ? answer.slice(0, 3900) + "\n\n... (truncated, full answer in dashboard)"
        : answer;
      await notifyTelegram(sendTelegram, task.telegramChatId, truncated);
    } catch {
      await notifyTelegram(
        sendTelegram,
        task.telegramChatId,
        "Answer complete -- check the dashboard for the full response.",
      );
    }

    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
    emit({ type: "task_update", taskId, status: "complete" });
    await notifyTelegram(sendTelegram, task.telegramChatId, `Question ${taskId.slice(0, 8)} answered.`);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTask(taskId, message, sendTelegram, task.telegramChatId);
  } finally {
    clearActiveSession(taskId);
    cleanupSeqCounters(taskId);
    releaseSlot();
  }
}
```

`src/orchestrator/questions/index.ts`:

```typescript
export { runQuestion } from "./pipeline.js";
```

Add to `src/orchestrator/index.ts`:

```typescript
export { runQuestion } from "./questions/index.js";
```

**Verify:** `npx tsc --noEmit`. Then `npm run dev`, send a codebase question via Telegram ("how does the classifier work in goodboy?"), confirm the bot replies with an answer.

**Commit:** `feat: add codebase question orchestrator`

---

### Task 8: Build the PR review orchestrator

**Files:**
- Create: `src/orchestrator/pr-review/prompts.ts`
- Create: `src/orchestrator/pr-review/pipeline.ts`
- Create: `src/orchestrator/pr-review/index.ts`
- Modify: `src/orchestrator/worktree.ts` (add `createPrWorktree`)
- Modify: `src/orchestrator/index.ts`

**Implementation:**

Add to `src/orchestrator/worktree.ts`:

```typescript
/** Create a worktree checked out to a PR's head ref. */
export async function createPrWorktree(
  repoPath: string,
  prNumber: string,
  taskId: string,
): Promise<string> {
  const dir = path.join(repoPath, "..", `goodboy-pr-${taskId.slice(0, 8)}`);

  // Clean up any existing worktree
  try {
    await exec("git", ["worktree", "remove", dir, "--force"], { cwd: repoPath });
  } catch { /* may not exist */ }

  const localBranch = `pr-review-${prNumber}-${taskId.slice(0, 8)}`;
  try {
    await exec("git", ["branch", "-D", localBranch], { cwd: repoPath });
  } catch { /* may not exist */ }

  await exec("git", ["fetch", "origin", `pull/${prNumber}/head:${localBranch}`], { cwd: repoPath });
  await exec("git", ["worktree", "add", dir, localBranch], { cwd: repoPath });

  log.info(`Created PR worktree at ${dir} for PR #${prNumber}`);
  return dir;
}
```

`src/orchestrator/pr-review/prompts.ts`:

```typescript
import { SHARED_RULES } from "../prompts.js";

export function prReviewSystemPrompt(
  prNumber: string,
  repoName: string,
  artifactsDir: string,
): string {
  return `You are reviewing a pull request. You have READ-ONLY access.
${SHARED_RULES}
READ-ONLY RULES:
- Use read and bash (grep, find, git diff, git log) to review the code
- Do NOT use write or edit tools EXCEPT to write the final review file
- Do NOT modify any file in the repository
- Do NOT run git commit, git push, or any git write operation

CONTEXT:
- Repository: ${repoName}
- Pull Request: #${prNumber}
- You are in a worktree checked out to the PR branch

YOUR JOB:
1. Run \`git log main..HEAD --oneline\` to see the PR's commits
2. Run \`git diff main\` to see all changes
3. Read the changed files in full context where needed
4. Write a thorough code review

Write your review to: ${artifactsDir}/pr-review.md

The review should include:
- Summary of what the PR does
- Issues found (bugs, edge cases, security, style)
- Positive aspects worth calling out
- Actionable suggestions with file paths and line numbers
- Overall verdict: approve / request changes / needs discussion

After writing pr-review.md, end your output with:
  {"status": "complete"}`;
}

export function prReviewInitialPrompt(prNumber: string, artifactsDir: string): string {
  return `Review PR #${prNumber}. Start by examining the diff and commits, then write your review to ${artifactsDir}/pr-review.md.`;
}
```

`src/orchestrator/pr-review/pipeline.ts`:

```typescript
import path from "node:path";
import { mkdir, rm, readFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config, loadEnv } from "../../shared/config.js";
import { emit } from "../../shared/events.js";
import { cleanupSeqCounters } from "../logs.js";
import { getRepo } from "../../shared/repos.js";
import { createPrWorktree, removeWorktree } from "../worktree.js";
import * as queries from "../../db/queries.js";
import {
  acquireSlot,
  releaseSlot,
  failTask,
  notifyTelegram,
  runStage,
  clearActiveSession,
  type SendTelegram,
} from "../shared.js";
import { prReviewSystemPrompt, prReviewInitialPrompt } from "./prompts.js";

const log = createLogger("pr-review");

export async function runPrReview(
  taskId: string,
  sendTelegram: SendTelegram,
): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task || !task.prIdentifier) {
    log.error(`Task ${taskId} not found or missing prIdentifier`);
    return;
  }

  const repo = getRepo(task.repo);
  if (!repo) {
    await failTask(taskId, `Repo '${task.repo}' not found`, sendTelegram, task.telegramChatId);
    return;
  }

  // Extract PR number from identifier (could be a URL or number)
  const prNumber = extractPrNumber(task.prIdentifier);
  if (!prNumber) {
    await failTask(taskId, `Could not parse PR number from: ${task.prIdentifier}`, sendTelegram, task.telegramChatId);
    return;
  }

  await acquireSlot();
  log.info(`Acquired slot for PR review ${taskId}`);

  await notifyTelegram(
    sendTelegram,
    task.telegramChatId,
    `Reviewing PR #${prNumber} in ${task.repo}...`,
  );

  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  let worktreePath: string;
  try {
    worktreePath = await createPrWorktree(repo.localPath, prNumber, taskId);
  } catch (err) {
    releaseSlot();
    await failTask(taskId, `Failed to create PR worktree: ${err}`, sendTelegram, task.telegramChatId);
    return;
  }

  await queries.updateTask(taskId, { worktreePath });

  const env = loadEnv();

  try {
    await runStage({
      taskId,
      stage: "pr_reviewing",
      cwd: worktreePath,
      systemPrompt: prReviewSystemPrompt(prNumber, task.repo, path.resolve(artifactsDir)),
      initialPrompt: prReviewInitialPrompt(prNumber, path.resolve(artifactsDir)),
      model: env.PI_MODEL,
      sendTelegram,
      chatId: task.telegramChatId,
      stageLabel: "PR Review",
    });

    // Send review via Telegram
    try {
      const review = await readFile(path.join(artifactsDir, "pr-review.md"), "utf-8");
      const truncated = review.length > 4000
        ? review.slice(0, 3900) + "\n\n... (truncated, full review in dashboard)"
        : review;
      await notifyTelegram(sendTelegram, task.telegramChatId, truncated);
    } catch {
      await notifyTelegram(
        sendTelegram,
        task.telegramChatId,
        "Review complete -- check the dashboard for the full review.",
      );
    }

    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
    emit({ type: "task_update", taskId, status: "complete" });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTask(taskId, message, sendTelegram, task.telegramChatId);
  } finally {
    // Clean up worktree
    try {
      await removeWorktree(repo.localPath, worktreePath);
    } catch { /* best effort */ }
    clearActiveSession(taskId);
    cleanupSeqCounters(taskId);
    releaseSlot();
  }
}

function extractPrNumber(identifier: string): string | null {
  // Handle URL: https://github.com/user/repo/pull/123
  const urlMatch = identifier.match(/\/pull\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  // Handle plain number
  const num = identifier.replace(/^#/, "").trim();
  if (/^\d+$/.test(num)) return num;
  return null;
}
```

`src/orchestrator/pr-review/index.ts`:

```typescript
export { runPrReview } from "./pipeline.js";
```

Add to `src/orchestrator/index.ts`:

```typescript
export { runPrReview } from "./pr-review/index.js";
```

**Verify:** `npx tsc --noEmit`. Then test via Telegram: "review PR #5 on goodboy".

**Commit:** `feat: add PR review orchestrator`

---

### Task 9: Wire bot handlers for all three kinds

**Files:**
- Modify: `src/bot/index.ts`

**Implementation:**

Add two new handler functions:

```typescript
import { runPipeline, runQuestion, runPrReview } from "../orchestrator/index.js";
import type { TaskKind } from "../shared/types.js";

async function handleCodebaseQuestion(
  intent: Extract<Intent, { type: "codebase_question" }>,
  chatId: string,
  sendTelegram: SendTelegram,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const repo = getRepo(intent.repo);
  if (!repo) {
    await reply(`Repo '${intent.repo}' not found. Available: ${repoNames().join(", ")}`);
    return;
  }

  const task = await queries.createTask({
    repo: intent.repo,
    kind: "codebase_question",
    description: intent.question,
    telegramChatId: chatId,
  });

  await reply(`Question received: ${task.id.slice(0, 8)}\nSearching the codebase...`);

  runQuestion(task.id, sendTelegram).catch((err) => {
    log.error(`Question error for task ${task.id}`, err);
  });
}

async function handlePrReview(
  intent: Extract<Intent, { type: "pr_review" }>,
  chatId: string,
  sendTelegram: SendTelegram,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const repo = getRepo(intent.repo);
  if (!repo) {
    await reply(`Repo '${intent.repo}' not found. Available: ${repoNames().join(", ")}`);
    return;
  }

  const task = await queries.createTask({
    repo: intent.repo,
    kind: "pr_review",
    description: `Review PR ${intent.prIdentifier}`,
    telegramChatId: chatId,
    prIdentifier: intent.prIdentifier,
  });

  await reply(`PR review started: ${task.id.slice(0, 8)}\nReviewing PR ${intent.prIdentifier}...`);

  runPrReview(task.id, sendTelegram).catch((err) => {
    log.error(`PR review error for task ${task.id}`, err);
  });
}
```

Update the `handleCodingTask` call to pass `kind: "coding_task"` to `createTask`.

Update the switch statement to call the new handlers instead of the placeholder replies:

```typescript
case "pr_review":
  await handlePrReview(intent, chatId, sendTelegram, reply);
  break;

case "codebase_question":
  await handleCodebaseQuestion(intent, chatId, sendTelegram, reply);
  break;
```

**Verify:** `npx tsc --noEmit`. Test all three intent types via Telegram.

**Commit:** `feat: wire bot handlers for question and PR review`

---

### Task 10: Update the API layer

**Files:**
- Modify: `src/api/index.ts`

**Implementation:**

Add `kind` filter to the tasks list endpoint:

```typescript
app.get("/api/tasks", async (c) => {
  const rawStatus = c.req.query("status");
  const status = rawStatus && TASK_STATUSES.includes(rawStatus as TaskStatus)
    ? (rawStatus as TaskStatus)
    : undefined;
  const repo = c.req.query("repo");
  const kind = c.req.query("kind") as TaskKind | undefined;
  const tasks = await queries.listTasks({ status, repo, kind });
  return c.json(tasks);
});
```

Update the retry endpoint to dispatch to the correct pipeline based on `task.kind`:

```typescript
app.post("/api/tasks/:id/retry", async (c) => {
  const task = await queries.getTask(c.req.param("id"));
  if (!task) return c.json({ error: "Not found" }, 404);
  if (task.status !== "failed") return c.json({ error: "Task is not in failed state" }, 409);

  await queries.updateTask(task.id, { status: "queued", error: null });
  const noopSend = async (_chatId: string, _text: string): Promise<void> => {};

  switch (task.kind) {
    case "coding_task":
      runPipeline(task.id, noopSend).catch((err) => log.error(`Retry error ${task.id}`, err));
      break;
    case "codebase_question":
      runQuestion(task.id, noopSend).catch((err) => log.error(`Retry error ${task.id}`, err));
      break;
    case "pr_review":
      runPrReview(task.id, noopSend).catch((err) => log.error(`Retry error ${task.id}`, err));
      break;
  }
  return c.json({ ok: true });
});
```

**Verify:** `npx tsc --noEmit`. Hit `/api/tasks?kind=codebase_question` and confirm filtering works.

**Commit:** `feat: add kind-aware API routing and filtering`

---

### Task 11: Update dashboard types and API client

**Files:**
- Modify: `dashboard/src/lib/api.ts`

**Implementation:**

Add `TaskKind` and update `Task` interface:

```typescript
export type TaskKind = "coding_task" | "codebase_question" | "pr_review";

export interface Task {
  id: string;
  repo: string;
  kind: TaskKind;
  description: string;
  status: TaskStatus;
  branch: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prIdentifier: string | null;
  error: string | null;
  telegramChatId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
```

Update `TaskStatus` to the generic set:

```typescript
export type TaskStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";
```

Add the task-kind config (mirror of backend):

```typescript
export const TASK_KIND_CONFIG: Record<TaskKind, {
  label: string;
  stages: string[];
  artifacts: { key: string; label: string }[];
}> = {
  coding_task: {
    label: "coding task",
    stages: ["planner", "implementer", "reviewer", "pr_creator"],
    artifacts: [
      { key: "plan.md", label: "plan" },
      { key: "implementation-summary.md", label: "summary" },
      { key: "review.md", label: "review" },
    ],
  },
  codebase_question: {
    label: "question",
    stages: ["answering"],
    artifacts: [{ key: "answer.md", label: "answer" }],
  },
  pr_review: {
    label: "PR review",
    stages: ["pr_reviewing"],
    artifacts: [{ key: "pr-review.md", label: "review" }],
  },
};
```

Add kind filter to `fetchTasks`:

```typescript
export async function fetchTasks(filters?: {
  status?: string;
  repo?: string;
  kind?: string;
}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.repo) params.set("repo", filters.repo);
  if (filters?.kind) params.set("kind", filters.kind);
  const qs = params.toString();
  return request(`/api/tasks${qs ? `?${qs}` : ""}`);
}
```

**Verify:** `npx tsc --noEmit -p dashboard/tsconfig.json` (or whatever the dashboard tsconfig is).

**Commit:** `feat: update dashboard types for multi-kind tasks`

---

### Task 12: Update StatusBadge for generic statuses

**Files:**
- Modify: `dashboard/src/components/StatusBadge.tsx`

**Implementation:**

Replace the status config with the generic set:

```typescript
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  queued: { label: "queued", color: "text-text-dim" },
  running: { label: "running", color: "text-accent" },
  complete: { label: "complete", color: "text-ok" },
  failed: { label: "failed", color: "text-fail" },
  cancelled: { label: "cancelled", color: "text-text-dim" },
  // Stage-level statuses (used in stage tabs)
  "running": { label: "running", color: "text-accent" },
};
```

Keep the pulsing dot for `running` status.

**Verify:** Visual check — task list and detail pages render correctly.

**Commit:** `refactor: simplify StatusBadge for generic statuses`

---

### Task 13: Update TaskRow with kind badge

**Files:**
- Modify: `dashboard/src/components/TaskRow.tsx`

**Implementation:**

Add a kind label between repo and description:

```typescript
import { TASK_KIND_CONFIG } from "@dashboard/lib/api";

// Inside the component, after the repo span:
<span className="shrink-0 font-mono text-[9px] text-text-ghost/50">
  {TASK_KIND_CONFIG[task.kind]?.label ?? task.kind}
</span>
```

**Verify:** Visual check — task list shows "coding task", "question", "PR review" labels.

**Commit:** `feat: show task kind in task list rows`

---

### Task 14: Update TaskDetail to branch on kind

**Files:**
- Modify: `dashboard/src/pages/TaskDetail.tsx`

**Implementation:**

Replace the hardcoded `ARTIFACTS` and `STAGE_ORDER` with kind-driven config:

```typescript
import { TASK_KIND_CONFIG } from "@dashboard/lib/api";

// Replace:
// const ARTIFACTS = [...]
// const STAGE_ORDER = [...]

// With (inside component, after task is loaded):
const kindConfig = TASK_KIND_CONFIG[task.kind] ?? TASK_KIND_CONFIG.coding_task;
const artifacts = kindConfig.artifacts;
const stageOrder = kindConfig.stages;
```

Conditionally render `PipelineProgress` only for coding tasks (single-stage kinds don't need it):

```typescript
{kindConfig.stages.length > 1 && (
  <div className="mb-8 flex justify-center py-4">
    <PipelineProgress stages={task.stages} kind={task.kind} />
  </div>
)}
```

For question tasks, show the answer prominently — auto-load `answer.md` when the task is complete:

```typescript
{task.kind === "codebase_question" && task.status === "complete" && (
  <AnswerSection taskId={taskId} />
)}
```

Where `AnswerSection` is a small inline component that fetches and displays `answer.md` automatically (no button click needed).

For PR review tasks, show the PR link at the top:

```typescript
{task.kind === "pr_review" && task.prIdentifier && (
  <span className="font-mono text-[10px] text-text-ghost">
    reviewing: {task.prIdentifier}
  </span>
)}
```

Update artifact buttons to use `kindConfig.artifacts` instead of hardcoded array.
Update stage tabs to use `stageOrder` instead of hardcoded `STAGE_ORDER`.

**Verify:** Navigate to a question task — see answer.md rendered inline, no pipeline progress bar. Navigate to a coding task — see existing view unchanged. Navigate to a PR review — see review.md and PR identifier.

**Commit:** `feat: branch TaskDetail rendering on task kind`

---

### Task 15: Make PipelineProgress kind-aware

**Files:**
- Modify: `dashboard/src/components/PipelineProgress.tsx`

**Implementation:**

Accept `kind` as a prop and derive stages from config:

```typescript
import { TASK_KIND_CONFIG, type TaskKind } from "@dashboard/lib/api";

interface PipelineProgressProps {
  stages: TaskStage[];
  kind: TaskKind;
  className?: string;
  mini?: boolean;
}

// Replace PIPELINE_STAGES with:
const kindConfig = TASK_KIND_CONFIG[kind];
const pipelineStages = kindConfig.stages.map((key) => ({
  key,
  label: key.replace("_", " "),
}));
```

For single-stage kinds, either render a single dot or return null (let the parent decide whether to render).

**Verify:** Visual check on all three task kinds.

**Commit:** `feat: make PipelineProgress kind-aware`

---

### Task 16: Add kind filter to Tasks page

**Files:**
- Modify: `dashboard/src/pages/Tasks.tsx`

**Implementation:**

Add a kind filter alongside the existing status filter (if there is one). Simple tab row: "all | coding | questions | PR reviews".

```typescript
const [kindFilter, setKindFilter] = useState<TaskKind | null>(null);

// Pass to fetchTasks:
const { data: tasks } = useQuery(
  () => fetchTasks({ kind: kindFilter ?? undefined }),
  [kindFilter],
);
```

Render filter tabs above the task list.

**Verify:** Click each filter tab, confirm filtering works.

**Commit:** `feat: add task kind filter to dashboard`

---

## Summary

| Phase | Tasks | What ships |
|-------|-------|-----------|
| Types + DB | 1-4 | Kind discriminator, generic statuses, extended stage names |
| Orchestrator refactor | 5-6 | Shared infra extracted, coding task moved to `dev-task/` |
| New orchestrators | 7-8 | Question answering + PR review pipelines |
| Bot wiring | 9 | All three kinds work via Telegram |
| API | 10 | Kind-aware routing and filtering |
| Dashboard | 11-16 | Kind-aware rendering throughout |

Tasks 1-9 are backend-only and can be tested entirely through Telegram. Tasks 10-16 bring the dashboard up to parity.
