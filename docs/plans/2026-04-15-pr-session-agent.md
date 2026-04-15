# PR Session Agent Implementation Plan

**Goal:** Replace the `pr_creator` pipeline stage and the stubbed `pr-review` module with a unified, stateful PR session agent that creates PRs, handles revision cycles from GitHub comments, and reviews external PRs.

**Approach:** Remove `pr_creator` from the dev-task pipeline. After the reviewer stage completes, hand off to a new PR session that persists as a pi session file on disk. The same session handles PR creation AND all subsequent revision rounds. External PR reviews enter the same system, just without an originating dev-task. A poller (or future webhook) detects new GitHub comments and resumes the session.

**Stack:** pi RPC with `--session <path>`, `gh` CLI for GitHub interactions, existing worktree infrastructure.

---

## Architecture Overview

```
BEFORE:
  dev-task:  planner > implementer > reviewer > pr_creator
  pr-review: stubbed

AFTER:
  dev-task:  planner > implementer > reviewer  (task completes here)
       |
       v
  pr-session: creates PR > waits > handles comments > waits > ...
  
  external:  telegram "review PR #42" > pr-session: reviews > comments > handles replies > ...
```

The PR session is a separate entity from the dev-task. It has its own lifecycle tied to the PR, not the task.

### Session file storage

```
data/pr-sessions/
  <prSessionId>.jsonl     e.g. a1b2c3d4-...-e5f6.jsonl
```

One file per PR session. Named by the `pr_sessions` row ID. No renaming. The DB tells you what repo/PR it belongs to.

### Key design decisions

1. **Session files live outside `artifacts/`** -- the PR lifecycle outlives the originating task.
2. **The dev-task worktree is NOT cleaned up on task completion** -- it's transferred to the PR session. Cleanup happens when the PR is merged/closed.
3. **Each resume is a new pi process** -- the session JSONL file provides continuity. No long-running processes.
4. **The PR session stores its metadata in the DB** -- a new `pr_sessions` table tracks repo, PR number, worktree path, and status. The session file path is derived from `config.prSessionsDir/<prSessionId>.jsonl`.

---

### Task 1: Add `--session` support to `pi-rpc.ts`

**Files:**
- Modify: `src/orchestrator/pi-rpc.ts`

**Implementation:**

Add optional `sessionPath` to the spawn options. When provided, use `--session <path>` instead of `--no-session`.

```typescript
// In the options interface, add:
sessionPath?: string;

// In the args builder, replace the hardcoded --no-session:
if (options.sessionPath) {
  args.push("--session", options.sessionPath);
} else {
  args.push("--no-session");
}
```

No other changes to pi-rpc.ts. The rest of the RPC protocol (sendPrompt, waitForCompletion, events) works identically.

**Verify:** Existing dev-task pipeline still works (no sessionPath passed = same behavior). Unit check: spawn with a sessionPath, send a prompt, confirm the JSONL file is created on disk.

**Commit:** `feat: add session file support to pi-rpc`

---

### Task 2: Create the `pr_sessions` DB table

**Files:**
- Modify: `src/db/schema.ts`

**Implementation:**

Add a new table to track PR sessions. This is separate from `tasks` because the PR session lifecycle is independent.

```typescript
export const prSessionStatusEnum = pgEnum("pr_session_status", [
  "active",    // PR is open, session is available for comments
  "closed",    // PR was merged or closed, session is done
]);

export const prSessions = pgTable("pr_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number"),               // null until PR is created
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  status: prSessionStatusEnum("pr_session_status").notNull().default("active"),
  /** The dev-task that originated this PR (null for external reviews) */
  originTaskId: uuid("origin_task_id").references(() => tasks.id),
  /** Telegram chat ID for notifications (avoids joins through originTaskId) */
  telegramChatId: text("telegram_chat_id"),
  /** Timestamp of last poll cycle (used to detect new comments) */
  lastPolledAt: timestamp("last_polled_at"),
  instance: text("instance").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Session file path is derived: config.prSessionsDir/<id>.jsonl
```

**After editing schema:** Run `npm run db:generate`. STOP -- do not apply migration. Wait for review.

**Commit:** `feat: add pr_sessions table schema`

---

### Task 3: Add PR session queries

**Files:**
- Modify: `src/db/queries.ts`

**Implementation:**

Add CRUD operations for the new table:

```typescript
// --- PR Sessions ---

export async function createPrSession(data: {
  repo: string;
  prNumber?: number;
  branch?: string;
  worktreePath?: string;
  originTaskId?: string;
  telegramChatId: string;
}): Promise<PrSession> { ... }

export async function getPrSession(id: string): Promise<PrSession | null> { ... }

export async function listActivePrSessions(): Promise<PrSession[]> { ... }

export async function updatePrSession(id: string, data: Partial<{
  status: "active" | "closed";
  prNumber: number;
  lastPolledAt: Date;
  worktreePath: string | null;
}>): Promise<PrSession | undefined> { ... }
```

**Verify:** `npm run build` passes.

**Commit:** `feat: add pr_sessions queries`

---

### Task 4: Create `pr-session/github.ts` -- gh CLI wrappers

**Files:**
- Create: `src/orchestrator/pr-session/github.ts`

**Implementation:**

Three thin wrappers around `gh` CLI -- only what the Node.js poller needs. The pi agent running inside the session calls `gh` directly for everything else (diffs, PR creation, posting reviews).

```typescript
/** Fetch top-level issue comments on a PR */
export async function getPrComments(nwo: string, prNumber: number): Promise<PrComment[]>

/** Fetch inline review comments on a PR (code-level feedback from reviews) */
export async function getPrReviewComments(nwo: string, prNumber: number): Promise<PrComment[]>

/** Check if PR is merged or closed */
export async function isPrClosed(nwo: string, prNumber: number): Promise<boolean>
```

Both comment functions return the same `PrComment` shape: `{id, author, body, createdAt}`. Review comments also include `path` and `line` so the agent knows which file/line the feedback targets.

- Issue comments: `gh pr view <number> --repo <nwo> --json comments`
- Review comments: `gh api /repos/{nwo}/pulls/{number}/comments`
- PR state: `gh pr view <number> --repo <nwo> --json state`

The `nwo` (name-with-owner, e.g. `Mishra-Manit/goodboy`) is extracted from the repo's `githubUrl` config, same as `cleanup.ts` does.

Comment filtering (by timestamp, by author) is done inline in the poller.

**Verify:** Manual test with a real PR: `npx tsx -e "import { getPrComments } from './src/orchestrator/pr-session/github.js'; ..."`

**Commit:** `feat: add GitHub CLI wrappers for PR session`

---

### Task 5: Create `pr-session/prompts.ts`

**Files:**
- Create: `src/orchestrator/pr-session/prompts.ts`

**Implementation:**

One system prompt with a `mode` flag. The two modes share 90% of the same instructions.

```typescript
export function prSessionPrompt(options: {
  mode: "own" | "review";   // "own" = we wrote the code, "review" = reviewing someone else's PR
  repo: string;
  branch: string;
  prNumber?: number;        // null on first run for "own" mode (PR not created yet)
  planPath?: string;        // only for "own" mode
  summaryPath?: string;     // only for "own" mode
  reviewPath?: string;      // only for "own" mode
}): string {
  // Shared rules:
  // - You can read/edit code, make commits, push, and interact via gh CLI.
  // - When given feedback, make targeted fixes -- don't rewrite everything.
  // - After making changes: commit, push, done.
  //
  // "own" mode additions:
  // - You created the code for this PR.
  // - If no PR exists yet: push branch, use gh pr create. Read artifacts for PR description.
  //
  // "review" mode additions:
  // - You are reviewing PR #N on repo X.
  // - Read the diff, write a thorough review via gh pr review.
  // - If you spot fixable issues, make commits and push.
}
```

**Commit:** `feat: add PR session prompts`

---

### Task 6: Create `pr-session/session.ts` -- core session logic

**Files:**
- Create: `src/orchestrator/pr-session/session.ts`

**Implementation:**

This is the core module. Three entry points:

#### `startPrSession` -- called after dev-task reviewer completes

```typescript
export async function startPrSession(options: {
  originTaskId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  artifactsDir: string;
  sendTelegram: SendTelegram;
  chatId: string;
}): Promise<void> {
  // 1. Create DB record in pr_sessions (prNumber = null initially)
  //    Session file path derived: config.prSessionsDir/<prSessionId>.jsonl
  
  // 2. Spawn pi with --session <derived path>, cwd = worktreePath
  //    System prompt = prSessionPrompt({ mode: "own", ... }) with artifact paths
  //    Initial prompt = "Push the branch and create a PR. Read the artifacts for context."
  
  // 3. Wait for completion. Parse PR URL from output.
  
  // 4. Update DB record with prNumber.
  
  // 5. Notify via Telegram: "PR #42 is up: <url>. I'll watch for comments."
  
  // 6. Kill process. Session file persists.
}
```

#### `resumePrSession` -- called when new comments are detected

```typescript
export async function resumePrSession(options: {
  prSessionId: string;
  comments: PrComment[];   // the new comments to address
  sendTelegram: SendTelegram;
}): Promise<void> {
  // 1. Look up pr_sessions record. Derive session file path from config.prSessionsDir/<id>.jsonl.
  //    Get telegramChatId from the row (no need to pass it in).
  
  // 2. Pull latest changes in worktree (in case of manual pushes):
  //    git pull --rebase in the worktree
  
  // 3. Spawn pi with --session <derived path>, cwd = worktreePath
  //    Reconstruct system prompt: derive mode from originTaskId (exists = "own", null = "review")
  //    Prompt = "New comments on your PR:\n\n<formatted comments>\n\nAddress the feedback, commit, and push."
  
  // 4. Wait for completion.
  
  // 5. Update lastPolledAt in DB.
  
  // 6. Notify via Telegram (using chatId from DB row): "Addressed N comments on PR #42, pushed changes."
  
  // 7. Kill process.
}
```

#### `startExternalReview` -- called for external PR review requests

```typescript
export async function startExternalReview(options: {
  repo: string;
  prNumber: number;
  sendTelegram: SendTelegram;
  chatId: string;
  taskId: string;
}): Promise<void> {
  // 1. Create worktree checked out to PR head (use existing createPrWorktree).
  
  // 2. Create DB record in pr_sessions (no originTaskId).
  //    Session file path derived: config.prSessionsDir/<prSessionId>.jsonl
  
  // 3. Spawn pi with --session <derived path>, cwd = worktree.
  //    System prompt = prSessionPrompt({ mode: "review", ... })
  //    Initial prompt = "Review this PR. Read the diff, understand the changes, post your review."
  
  // 4. Wait for completion.
  
  // 5. Notify via Telegram with the review summary.
  
  // 6. Kill process. Session persists for follow-up discussion.
}
```

**Verify:** Will be tested end-to-end after integration.

**Commit:** `feat: implement PR session core (start, resume, external review)`

---

### Task 7: Remove `pr_creator` from the dev-task pipeline

**Files:**
- Modify: `src/orchestrator/dev-task/pipeline.ts`
- Modify: `src/orchestrator/dev-task/prompts.ts`
- Modify: `src/orchestrator/dev-task/index.ts`

**Implementation:**

In `pipeline.ts`:
- Remove the `pr_creator` stage call from `runPipeline`.
- After the reviewer stage completes, instead of marking the task as complete, call `startPrSession` to hand off.
- The task is marked complete BEFORE the PR session starts (the PR session is a separate lifecycle).
- Pass the worktree path, artifacts dir, branch to `startPrSession`.

```typescript
// Stage 3: Reviewer (final pipeline stage)
await runCodingStage(taskId, "reviewer", ...);
await requireArtifact(artifactsDir, "review.md", "...");

// Pipeline done -- mark task complete
await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
emit({ type: "task_update", taskId, status: "complete" });
await notifyTelegram(sendTelegram, task.telegramChatId, `Task ${task.id.slice(0, 8)} is complete. Handing off to PR session...`);

// Hand off to PR session (runs independently, sends its own Telegram notification when PR is up)
startPrSession({
  originTaskId: taskId,
  repo: task.repo,
  branch,
  worktreePath,
  artifactsDir,
  sendTelegram,
  chatId: task.telegramChatId!,
}).catch((err) => {
  log.error(`PR session failed for task ${taskId}`, err);
  notifyTelegram(sendTelegram, task.telegramChatId, `PR session failed: ${err.message}`);
});
```

In `prompts.ts`:
- Remove `prCreatorPrompt` export.
- Keep `revisionPrompt` for now (may be useful as reference), or remove it since the PR session handles revisions.

In `pipeline.ts`:
- Remove `pr_creator` from `STAGE_DISPLAY_NAMES` and `STAGE_MODEL_KEYS`.
- Remove the `pr_creator` case from `getCodingSystemPrompt` and `getCodingInitialPrompt`.
- Remove `extractPrUrl` and `extractPrNumber` helpers (move to pr-session if needed).

**Note:** The worktree already survives task completion -- the pipeline's `finally` block only clears session state and log counters, never touches the worktree. Worktree deletion only happens via explicit `dismissTask` in `cleanup.ts`. No changes needed here.

**Verify:** Run a dev-task end-to-end. It should complete after the reviewer stage and kick off the PR session.

**Commit:** `refactor: remove pr_creator stage, hand off to PR session`

---

### Task 8: Rewire `pr-review` to use the new PR session

**Files:**
- Rewrite: `src/orchestrator/pr-review/pipeline.ts`
- Modify: `src/orchestrator/pr-review/index.ts`

**Implementation:**

Replace the stub with a call to `startExternalReview`:

```typescript
export async function runPrReview(
  taskId: string,
  sendTelegram: SendTelegram,
): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task || !task.prIdentifier) {
    log.error(`Task ${taskId} not found or missing prIdentifier`);
    return;
  }

  // Extract PR number from identifier (could be a number or URL)
  const prNumber = extractPrNumber(task.prIdentifier);
  if (!prNumber) {
    await failTask(taskId, `Could not parse PR number from: ${task.prIdentifier}`, sendTelegram, task.telegramChatId);
    return;
  }

  await queries.updateTask(taskId, { status: "running" });

  try {
    await startExternalReview({
      repo: task.repo,
      prNumber,
      sendTelegram,
      chatId: task.telegramChatId!,
      taskId,
    });

    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
  } catch (err) {
    await failTask(taskId, err instanceof Error ? err.message : String(err), sendTelegram, task.telegramChatId);
  }
}
```

**Verify:** Send a "review PR #X on repo Y" message via Telegram. Confirm it checks out the PR and runs a review.

**Commit:** `feat: wire pr-review to PR session agent`

---

### Task 9: Implement the PR comment poller

**Files:**
- Rewrite: `src/orchestrator/pr-poller.ts`

**Implementation:**

Replace the stub with a real poller that checks active PR sessions for new comments.

```typescript
const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

export function startPrPoller(sendTelegram: SendTelegram): void {
  // Use a sequential for-loop, not parallel. One PR at a time.
  //
  // async function pollOnce(): Promise<void> {
  //   const sessions = await listActivePrSessions();
  //   for (const session of sessions) {
  //     // Skip sessions with prNumber = 0 (PR not created yet)
  //     if (!session.prNumber) continue;
  //
  //     // Skip if this session is currently being resumed
  //     if (inFlight.has(session.id)) continue;
  //
  //     // Check if PR is still open
  //     const closed = await isPrClosed(nwo, session.prNumber);
  //     if (closed) {
  //       await updatePrSession(session.id, { status: "closed" });
  //       await cleanupPrSession(session.id);
  //       continue;
  //     }
  //
  //     // Fetch both comment types, merge, filter to new ones
  //     const issueComments = await getPrComments(nwo, session.prNumber);
  //     const reviewComments = await getPrReviewComments(nwo, session.prNumber);
  //     const allComments = [...issueComments, ...reviewComments];
  //     const newComments = allComments.filter(c => !session.lastPolledAt || new Date(c.createdAt) > session.lastPolledAt);
  //     // Filter out bot's own comments
  //     const humanComments = newComments.filter(c => c.author !== "github-actions[bot]");
  //     if (humanComments.length === 0) {
  //       await updatePrSession(session.id, { lastPolledAt: new Date() });
  //       continue;
  //     };
  //
  //     // Resume session
  //     inFlight.add(session.id);
  //     try {
  //       await resumePrSession({ prSessionId: session.id, comments: humanComments, sendTelegram });
  //     } finally {
  //       inFlight.delete(session.id);
  //     }
  //   }
  // }
  //
  // setInterval(() => pollOnce().catch(err => log.error("Poll cycle failed", err)), POLL_INTERVAL_MS);
}
```

Key details:
- Only poll sessions with `status = "active"`.
- Use `lastPolledAt` timestamp to avoid re-processing old comments. Covers both issue comments and inline review comments.
- Track which sessions are currently being resumed to avoid double-processing.
- Check `isPrClosed()` periodically. If the PR is merged/closed, update the session status to `"closed"` and trigger worktree cleanup via `cleanupTaskResources` or a new `cleanupPrSession`.
- The poller needs `sendTelegram` so it can notify you when it addresses comments. Thread this through from `index.ts`.

**Verify:** Open a PR, add a comment, wait for the poller to pick it up and resume the session.

**Commit:** `feat: implement PR comment poller`

---

### Task 10: Update types and task-kinds config

**Files:**
- Modify: `src/shared/task-kinds.ts`

**Implementation:**

Remove `"pr_creator"` from the `coding_task` stages array:

```typescript
coding_task: {
  label: "coding task",
  stages: ["planner", "implementer", "reviewer"],
  artifacts: [
    { key: "plan.md", label: "plan" },
    { key: "implementation-summary.md", label: "summary" },
    { key: "review.md", label: "review" },
  ],
},
```

Do NOT remove `"pr_creator"` from the Postgres `stageNameEnum` -- old rows reference it. Do NOT add `"pr_session"` as a stage name -- PR sessions are a separate entity, not task stages. They log through the standard logger, not the stage system.

**Verify:** `npm run build` passes. Dashboard still renders existing task stages correctly.

**Commit:** `refactor: remove pr_creator from task-kinds config`

---

### Task 11: Update cleanup to handle PR sessions

**Files:**
- Modify: `src/orchestrator/cleanup.ts`

**Implementation:**

Add a `cleanupPrSession` function:

```typescript
export async function cleanupPrSession(prSessionId: string): Promise<void> {
  // 1. Look up pr_sessions record
  // 2. Remove worktree (if exists)
  // 3. Delete local branch
  // 4. Update pr_sessions status to "closed"
  // 5. Optionally delete session file (or keep for history)
}
```

Modify `dismissTask` to also clean up any associated PR session (via `originTaskId`).

The poller (Task 10) calls this when it detects a PR has been merged/closed.

**Verify:** Merge a PR, confirm the poller detects it and cleans up the worktree.

**Commit:** `feat: add PR session cleanup`

---

### Task 12: Wire up the poller in `index.ts`

**Files:**
- Modify: `src/index.ts`

**Implementation:**

The poller needs `sendTelegram`, which is created inside `createBot()`. Either:
- Have `startPrPoller` accept `sendTelegram` as a parameter (cleanest).
- Or export the bot's `sendTelegram` separately.

```typescript
// In index.ts, after bot is created:
const sendTelegram: SendTelegram = async (chatId, text) => {
  await bot.api.sendMessage(Number(chatId), text);
};

startPrPoller(sendTelegram);
```

**Verify:** Server starts without errors. Poller logs show it's running.

Also update `orchestrator/index.ts` exports to include the new PR session functions.

**Commit:** `feat: start PR poller on server boot`

---

### Task 13: Create `data/pr-sessions/` directory and add to `.gitignore`

**Files:**
- Modify: `.gitignore`
- Create: `data/pr-sessions/.gitkeep`

**Implementation:**

Add to `.gitignore`:
```
data/pr-sessions/
!data/pr-sessions/.gitkeep
```

Also ensure `config.ts` exports the path:

```typescript
export const config = {
  artifactsDir: path.resolve(__dirname, "../../artifacts"),
  prSessionsDir: path.resolve(__dirname, "../../data/pr-sessions"),
  piCommand: "pi",
} as const;
```

**Commit:** `chore: add pr-sessions data directory`

---

## Execution Order

Tasks 1-3 are foundational (no dependencies between them).
Tasks 4-5 are independent building blocks.
Task 6 depends on 1-5.
Tasks 7-8 depend on 6.
Task 9 depends on 4 and 6.
Tasks 10-13 are integration that can be done alongside or after.

Suggested linear order: 13, 1, 2, 3, 4, 5, 6, 7, 8, 10, 9, 11, 12.

---

## What this does NOT cover (future work)

- **Dashboard UI for PR sessions** -- the dashboard currently shows tasks/stages. PR sessions would need their own view (list of active PRs, session history, comment thread). Separate feature.
- **Webhook-based comment detection** -- the poller handles this. A webhook could supplement it for lower latency in the future but is not needed.
- **PR session compaction** -- pi handles auto-compaction, but very long-lived PRs (20+ rounds) might need manual intervention. Monitor and address if it becomes an issue.
- **Multi-repo PR sessions** -- currently assumes one worktree per PR. Cross-repo PRs are out of scope.
- **Telegram commands for PR sessions** -- e.g. "list active PRs", "close PR session for #42". Would need new classifier intents.
