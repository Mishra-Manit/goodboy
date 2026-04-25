# PR Review Pipeline Implementation Plan

**Goal:** Turn `pr_review` from a stub into a real pipeline with three stages:

1. **`memory`** — standard memory run, identical to coding/question pipelines.
2. **`pr_impact`** — memory-derived synthesis pass. Reads memory + diff, produces `pr-impact.md`, a PR-scoped pre-filter of memory for the analyst.
3. **`pr_analyst`** — the heavy stage. Reads the full PR, fans out a fleet of subagents to review every file group + cross-cutting concerns, aggregates all reports, applies every auto-fixable issue with real commits pushed back to the PR branch, and posts a single structured comment summarizing everything it fixed and everything the author still needs to address.

**Approach:** Thin outer pipeline in `pr-review/pipeline.ts`: `syncRepo → runMemory → fetch PR context → runImpactAnalyzer → runPrAnalyst`. The real work is in `pr_analyst`, which runs as a pi session with `pi-subagents` capability, full memory injected, and `pr-impact.md` as its primary lens.

---

## Locked invariants

1. **Same-repo only (v1).** Fork PRs are out of scope. Because it's always same-repo, the PR's head branch exists at `origin/<headRef>` and can be fetched and pushed to directly — no `pull/<N>/head` gymnastics needed.
2. **One writer, many readers.** The analyst edits files and commits. Every subagent it spawns is read-only and returns a structured JSON report only.
3. **Fan-out:** N file-group subagents (`ceil(changedFiles / 2)`, capped at 10) for `correctness` + `style`. Plus 1 holistic subagent for `tests` + `security` + cross-cutting.
4. **Auto-fix rule:** `style` at any severity and `correctness` at `minor`/`nit` are auto-fixed. `correctness` at `major`/`blocker`, any `security`, and anything requiring a design choice are flag-only — described in the final comment, not touched.
5. **Output:** one `gh pr comment` summary. No `gh pr review --approve/--request-changes`. No inline line comments in v1.
6. **Memory always runs first.** `runMemory` runs after `syncRepo`, before everything else. Soft-fails always.
7. **Impact stage is memory-derived and repo-isolated.** Its cwd is `artifactsDir` — it sees only `pr.diff` + `pr-context.json`. No grep, no file opens outside artifacts. All codebase knowledge comes from the injected `memoryBlock`. Always runs; soft-fails on LLM error/timeout (analyst proceeds without `pr-impact.md`).
8. **Analyst gets both context layers.** Full `memoryBlock` (repo-wide view) + `pr-impact.md` (PR-scoped pre-filter). Analyst distills per-group focus strings from `pr-impact.md` before spawning subagents. Subagents get the distilled focus, not the full memory block — they stay lean.
9. **Commit-back before comment.** Fixes are committed (1–3 logical commits, conventional prefixes) and pushed to the PR branch before the final comment is posted. The comment's "Fixes pushed" section cites the short SHAs.
10. **Follow-up replies:** humans reply to the summary comment → existing poller + `resumePrSession` loop handles it. No new wiring needed.

---

## What the memory system gives us (already landed)

Already in the codebase — this plan depends on it, does not build it:

- `runMemory({ taskId, repo, repoPath, source, sendTelegram, chatId })` in `src/pipelines/memory/pipeline.ts`. Soft-fail.
- `memoryBlock(repo)` in `src/shared/agent-prompts.ts`. Async. Returns `""` if no memory exists. Concatenates every zone's `.md` files into a single prompt block.
- `memory` is already in `STAGE_NAMES`. Memory run records + `memory_run_update` SSE events stream to the dashboard automatically.
- `resumePrSession` already injects `memoryBlock` + subagent capability. The new `pr_analyst` turn uses the same pattern.

---

## File layout

```
src/
  shared/types.ts                                  MODIFIED: PrReviewIssue, PrReviewReport, PrReviewPlan
                                                             add "pr_impact", "pr_analyst" to STAGE_NAMES
                                                             remove "pr_reviewing" (replace with pr_analyst)
  db/schema.ts                                     MODIFIED: stageNameEnum
  shared/config.ts                                 MODIFIED: add PI_MODEL_PR_IMPACT, PI_MODEL_PR_ANALYST
  core/git/github.ts                               MODIFIED: add getPrMetadata, getPrDiff helpers
  core/git/worktree.ts                             MODIFIED: createPrWorktree — fetch actual branch instead of pull/<N>/head
  pipelines/pr-review/pipeline.ts                  MODIFIED: stub -> real thin pipeline
                                                             (runMemory -> fetch context -> runImpactAnalyzer -> runPrAnalyst)
  pipelines/pr-review/impact-analyzer.ts           NEW: runImpactAnalyzer (memory-derived, no repo access)
  pipelines/pr-review/impact-prompts.ts            NEW: impactAnalyzerSystemPrompt, impactAnalyzerInitialPrompt
  pipelines/pr-review/analyst.ts                   NEW: runPrAnalyst — pi session with subagents, commits, comment
  pipelines/pr-review/analyst-prompts.ts           NEW: prAnalystSystemPrompt, prAnalystInitialPrompt
  telegram/handlers.ts                             MODIFIED: remove pr_review short-circuit, route to createAndStart
.env.example                                       MODIFIED: PI_MODEL_PR_IMPACT, PI_MODEL_PR_ANALYST
drizzle/
  <next>_pr_analyst_stages.sql                     NEW: generated migration
tests/
  unit/shared/pr-review-schemas.test.ts            NEW
  unit/core/git/pr-context.test.ts                 NEW
  unit/pipelines/pr-review/impact-prompts.test.ts  NEW
  unit/pipelines/pr-review/analyst-prompts.test.ts NEW
```

`TASK_KINDS` already includes `pr_review`. `STAGE_NAMES` already includes `memory`. The two additions are `pr_impact` and `pr_analyst` (replacing `pr_reviewing`).

---

## Task 1: Add `pr_impact` and `pr_analyst` to stage registry + generate migration

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/db/schema.ts`

In `shared/types.ts`, update `STAGE_NAMES` under the `pr_review` section:

```ts
export const STAGE_NAMES = [
  // runs before every coding_task / codebase_question / pr_review
  "memory",
  // coding_task
  "planner",
  "implementer",
  "reviewer",
  "pr_creator",
  "revision",
  // codebase_question
  "answering",
  // pr_review
  "pr_impact",
  "pr_analyst",
] as const;
```

Mirror in `db/schema.ts`'s `stageNameEnum` (remove `pr_reviewing`, add `pr_impact` + `pr_analyst`).

Then generate the migration:

```bash
npm run db:generate
```

Do NOT `db:migrate` yet — human applies from laptop before the code that reads the new values merges.

**Verify:** `npm run build` clean.

**Commit:** `feat(pr-review): add pr_impact + pr_analyst stage names, drop pr_reviewing + drizzle migration`

---

## Task 2: Add Zod schemas for the PR review contract

**Files:**
- Modify: `src/shared/types.ts`

Append a new section. Keep existing sections untouched.

```ts
// --- PR review contract ---

export const PR_REVIEW_SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export const PR_REVIEW_CATEGORIES = ["correctness", "style", "tests", "security"] as const;
export const PR_REVIEW_DIMENSIONS = PR_REVIEW_CATEGORIES;

export const prReviewIssueSchema = z.object({
  file: z.string(),
  line_start: z.number().int().nonnegative(),
  line_end: z.number().int().nonnegative(),
  severity: z.enum(PR_REVIEW_SEVERITIES),
  category: z.enum(PR_REVIEW_CATEGORIES),
  title: z.string().min(1),
  rationale: z.string().min(1),
  suggested_fix: z.string().min(1),
});
export type PrReviewIssue = z.infer<typeof prReviewIssueSchema>;

export const prReviewReportSchema = z.object({
  subagent_id: z.string().min(1),
  files_reviewed: z.array(z.string()),
  dimensions: z.array(z.enum(PR_REVIEW_DIMENSIONS)).min(1),
  issues: z.array(prReviewIssueSchema),
  notes: z.string().default(""),
});
export type PrReviewReport = z.infer<typeof prReviewReportSchema>;

export const prReviewPlanSchema = z.object({
  groups: z.array(z.object({
    id: z.string(),
    files: z.array(z.string()).min(1),
    dimensions: z.array(z.enum(PR_REVIEW_DIMENSIONS)).min(1),
    focus: z.string().default(""),
  })),
  skipped: z.array(z.string()),
  focus_notes: z.string(),
});
export type PrReviewPlan = z.infer<typeof prReviewPlanSchema>;
```

**Verify:** `npm run build`

**Commit:** `feat(pr-review): add zod schemas for review plan and subagent reports`

---

## Task 3: Fix `createPrWorktree` to check out the real branch

**Files:**
- Modify: `src/core/git/worktree.ts`

**Problem with the current implementation:**

```ts
// current — fetches the anonymous head ref into a throwaway local branch
await exec("git", ["fetch", "origin", `pull/${prNumber}/head:${localBranch}`], { cwd: repoPath });
```

This creates a local branch named `pr-review-<N>-<taskId>` that has no connection to the real remote branch. Since we're same-repo only, the PR's branch always exists at `origin/<headRef>` — just check it out directly.

**New signature:**

```ts
/** Create a worktree checked out to a PR's head branch. Same-repo only. */
export async function createPrWorktree(
  repoPath: string,
  headRef: string,   // the actual branch name, e.g. "feature/my-thing"
  taskId: string,
): Promise<string>
```

**Implementation:**

```ts
export async function createPrWorktree(
  repoPath: string,
  headRef: string,
  taskId: string,
): Promise<string> {
  const dir = path.join(repoPath, "..", `goodboy-pr-${taskId.slice(0, 8)}`);

  await forceRemoveWorktree(repoPath, dir);
  // Wipe any stale local copy of the branch so the fetch is clean.
  await forceDeleteBranch(repoPath, headRef);

  // Fetch the real branch from origin into a same-named local branch.
  // `${headRef}:${headRef}` means: remote branch headRef -> local branch headRef.
  await exec("git", ["fetch", "origin", `${headRef}:${headRef}`], { cwd: repoPath });
  await exec("git", ["worktree", "add", dir, headRef], { cwd: repoPath });

  log.info(`Created PR worktree at ${dir} on branch ${headRef}`);
  await stageSubagentAssets(dir);
  return dir;
}
```

Now the worktree is on the real PR branch. The analyst does `git push origin ${headRef}` — no refspec magic.

Update the one existing call site in `session.ts`:

```ts
// was: createPrWorktree(repoConfig.localPath, String(prNumber), taskId)
const worktreePath = await createPrWorktree(repoConfig.localPath, options.headRef, taskId);
```

**Verify:** `npm run build`

**Commit:** `fix(worktree): createPrWorktree fetches actual branch instead of pull/<N>/head`

---

## Task 4: gh CLI helpers for PR context

**Files:**
- Modify: `src/core/git/github.ts`

Add to the `// --- gh CLI wrappers ---` section:

```ts
export interface PrMetadata {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  baseRef: string;
  headRef: string;
  changedFiles: Array<{ path: string; additions: number; deletions: number }>;
}

/** Fetch PR metadata needed for the analyst prompt. Throws on failure. */
export async function getPrMetadata(nwo: string, prNumber: number): Promise<PrMetadata> {
  const { stdout } = await exec("gh", [
    "pr", "view", String(prNumber),
    "--repo", nwo,
    "--json", "number,title,body,labels,author,baseRefName,headRefName,files",
  ]);
  const data = JSON.parse(stdout) as {
    number: number; title: string; body: string;
    labels: Array<{ name: string }>; author: { login: string };
    baseRefName: string; headRefName: string;
    files: Array<{ path: string; additions: number; deletions: number }>;
  };
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    labels: data.labels.map((l) => l.name),
    author: data.author.login,
    baseRef: data.baseRefName,
    headRef: data.headRefName,
    changedFiles: data.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
  };
}

/** Fetch the unified diff for a PR. Throws on failure. */
export async function getPrDiff(nwo: string, prNumber: number): Promise<string> {
  const { stdout } = await exec("gh", ["pr", "diff", String(prNumber), "--repo", nwo]);
  return stdout;
}
```

**Verify:** `npm run build`

**Commit:** `feat(pr-review): add getPrMetadata and getPrDiff gh wrappers`

---

## Task 5: Memory-derived impact stage

**Files:**
- Create: `src/pipelines/pr-review/impact-prompts.ts`
- Create: `src/pipelines/pr-review/impact-analyzer.ts`
- Modify: `src/shared/config.ts` — add `PI_MODEL_PR_IMPACT`
- Modify: `.env.example`

### Design

The `pr_impact` stage is a **pure synthesis step**. Inputs: `memoryBlock(repo)` + the staged diff. Output: `pr-impact.md` — five sections the analyst reads as its primary lens.

**No repo access.** cwd is `artifactsDir`, so the agent's tools only see `pr.diff` and `pr-context.json`. This is deliberate: it forces memory-grounded reasoning and prevents a giant tool-use preamble before the analyst starts.

**No subagents.** One reasoning pass. Fast, cheap model preferred.

**Always runs.** If `memoryBlock` returns `""`, the agent still runs and produces a "flying blind" degraded report. On LLM error/timeout, soft-fail — analyst proceeds without `pr-impact.md`.

### `src/pipelines/pr-review/impact-prompts.ts`

```ts
/**
 * Prompts for the pr_impact stage. Memory-derived synthesis: the agent sees
 * only the injected memory block and the staged PR diff. No repo access.
 */

export function impactAnalyzerSystemPrompt(
  repo: string,
  artifactsDir: string,
  memoryBody: string,
): string {
  const memorySection = memoryBody
    ? memoryBody
    : `NO MEMORY AVAILABLE for ${repo}. Produce the report from the diff alone.
Every section will be thin — that is fine. The "Memory Gaps" section should
flag every touched area as uncovered so the analyst knows to work harder.`;

  return `You are the PR Impact Analyzer for "${repo}".

Your job: produce a PR-scoped pre-filter of the codebase memory. The pr_analyst
stage reads your report as its primary lens on this PR. Be tight, structured,
and memory-grounded.

WHAT YOU HAVE:
- The full codebase memory (injected below). Your ONLY view of the repo.
  You cannot open source files. You cannot grep. Do not try.
- PR diff at ${artifactsDir}/pr.diff
- PR metadata at ${artifactsDir}/pr-context.json

WHAT YOU DO NOT HAVE:
- Access to any file outside ${artifactsDir}. Do not attempt it.

${memorySection}

YOUR TASK:
Read both artifact files, reason about the diff in light of the memory above,
then write ${artifactsDir}/pr-impact.md using EXACTLY these five section headers
in this order. If a section has nothing to say, write "None identified."

  # Impact Analysis — PR #<number>: <title>

  ## Summary
  One paragraph. What the PR changes, which memory zones it touches, and the
  single biggest risk area according to memory.

  ## Touched Zones
  For every memory zone this PR's changed files fall into: zone name, zone
  summary (quoted verbatim from memory), and the PR files that land there.
  Files outside every zone go under "_root".

  ## Affected Symbols & Concepts
  Exported symbols or architectural concepts the diff changes. For each, cite
  the memory line that mentions it (quote + [path:line]). Changed symbols
  absent from memory go under "Not in memory" — a signal for the analyst.

  ## Risks per Memory
  Invariants and patterns the memory records for touched zones, projected onto
  what the diff does. Format:
    - [zone] <one-line risk> — memory says: "<quote>" [path:line]
      diff impact: <one-line assessment>
  Only list risks where the diff actually interacts with the memory claim.

  ## Memory Gaps
  Places the PR touches that memory does NOT cover well. Be specific. This
  tells the analyst: "here, you are flying blind — be extra careful."

CONSTRAINTS:
- READ-ONLY. You may ONLY write to ${artifactsDir}/pr-impact.md.
- Every concrete claim must cite the memory line it came from.
- Do NOT cite from first-hand file inspection. You cannot inspect files.
- Do not rename or reorder the five section headers.

End your output with "IMPACT_ANALYSIS_DONE".`;
}

export function impactAnalyzerInitialPrompt(artifactsDir: string): string {
  return `Begin the impact analysis. Read ${artifactsDir}/pr-context.json and ${artifactsDir}/pr.diff, then write the complete ${artifactsDir}/pr-impact.md covering all five sections. Project the memory above onto this specific diff. Do not attempt to read source files.`;
}
```

### `src/pipelines/pr-review/impact-analyzer.ts`

```ts
/**
 * pr_impact stage. Memory-derived synthesis: reads memory + PR diff,
 * produces pr-impact.md. Soft-fails always. cwd = artifactsDir (sandboxed).
 */

import { createLogger } from "../../shared/logger.js";
import { loadEnv } from "../../shared/config.js";
import { runStage, type SendTelegram } from "../../core/stage.js";
import { memoryBlock } from "../../shared/agent-prompts.js";
import { impactAnalyzerSystemPrompt, impactAnalyzerInitialPrompt } from "./impact-prompts.js";

const log = createLogger("pr-impact");

const IMPACT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ImpactAnalyzerOptions {
  taskId: string;
  repo: string;
  artifactsDir: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
}

/**
 * Run the pr_impact stage. Never throws. Writes pr-impact.md on success;
 * leaves it absent on failure so the analyst can detect and degrade gracefully.
 */
export async function runImpactAnalyzer(opts: ImpactAnalyzerOptions): Promise<void> {
  const { taskId, repo, artifactsDir, sendTelegram, chatId } = opts;
  try {
    const memoryBody = await memoryBlock(repo);
    await runStage({
      taskId,
      stage: "pr_impact",
      cwd: artifactsDir,
      systemPrompt: impactAnalyzerSystemPrompt(repo, artifactsDir, memoryBody),
      initialPrompt: impactAnalyzerInitialPrompt(artifactsDir),
      model: modelForImpact(),
      sendTelegram,
      chatId,
      stageLabel: "PR Impact Analysis",
      timeoutMs: IMPACT_TIMEOUT_MS,
    });
  } catch (err) {
    log.warn(`pr_impact failed for ${taskId}: ${err instanceof Error ? err.message : String(err)} — analyst proceeds without report`);
  }
}

function modelForImpact(): string {
  const env = loadEnv();
  return env.PI_MODEL_PR_IMPACT ?? env.PI_MODEL;
}
```

### Config + env

In `src/shared/config.ts`:
```ts
PI_MODEL_PR_IMPACT: z.string().optional(),
```

In `.env.example`:
```
# Light, fast model for the pr_impact synthesis pass. Falls back to PI_MODEL.
PI_MODEL_PR_IMPACT=
```

**Verify:** `npm run build`

**Commit:** `feat(pr-review): pr_impact stage — memory-derived synthesis, sandboxed cwd`

---

## Task 6: The pr_analyst stage

This is the core of the pipeline. The `pr_analyst` receives the full memory block and `pr-impact.md`, fans out a fleet of subagents to review every file group, aggregates all their JSON reports, applies every auto-fixable issue with real commits pushed to the PR branch, then posts a single structured comment.

**Files:**
- Create: `src/pipelines/pr-review/analyst-prompts.ts`
- Create: `src/pipelines/pr-review/analyst.ts`
- Modify: `src/shared/config.ts` — add `PI_MODEL_PR_ANALYST`
- Modify: `.env.example`

### `src/pipelines/pr-review/analyst-prompts.ts`

```ts
/**
 * Prompts for the pr_analyst stage — the main PR review orchestrator.
 * Receives full memory + pr-impact.md, fans out subagents, commits fixes,
 * and posts the final comment.
 *
 * Memory is NOT embedded here; it is prepended at the call site via
 * memoryBlock(repo), matching the coding/question/resumePrSession pattern.
 */

export interface PrAnalystPromptOptions {
  repo: string;
  nwo: string;
  /** The PR's head branch name (e.g. "feature/my-thing"). The worktree is
   * checked out directly on this branch — git push just works. */
  headRef: string;
  prNumber: number;
  artifactsDir: string;
  worktreePath: string;
}

export function prAnalystSystemPrompt(opts: PrAnalystPromptOptions): string {
  const { repo, nwo, headRef, prNumber, artifactsDir, worktreePath } = opts;
  return `You are the PR Analyst for "${repo}", PR #${prNumber}.

You own this review end to end: read the PR, launch a fleet of subagents to
review every part of it, aggregate their findings, fix everything auto-fixable
with real commits pushed to the branch, and post a single summary comment.

YOU HAVE THE PI-SUBAGENTS TOOL. Use it. Do not attempt to review a non-trivial
PR alone — you will miss things. Spawn aggressively.

---

CONTEXT YOU HAVE:
- Codebase memory (the "CODEBASE MEMORY" block prepended above): full agent-
  maintained knowledge base for this repo. Understand WHY code is written the
  way it is, which patterns and invariants the repo holds.
- PR impact report at ${artifactsDir}/pr-impact.md (if present): memory-derived,
  PR-scoped pre-filter. Start here — it tells you which zones and risks are
  relevant to this diff. If absent, fall back to the full memory block.
- PR metadata at ${artifactsDir}/pr-context.json
- PR diff at ${artifactsDir}/pr.diff
- Full worktree at ${worktreePath} (for applying fixes).

---

AUTO-FIX RULE (non-negotiable):
- AUTO-FIX: category=style (any severity), category=correctness severity in {minor, nit}.
- FLAG-ONLY: category=correctness severity in {major, blocker}, any category=security,
  anything that requires a design choice or author judgement.
  DO NOT TOUCH flag-only code. Describe it in the comment for the author.

---

COMMIT RULE:
- Your worktree is checked out directly on ${headRef} — the real PR branch.
  Push with: git push origin ${headRef}
- Group fixes into 1–3 logical commits. Conventional prefixes (fix:, style:,
  refactor:, test:). Never --force.
- Commit BEFORE posting the comment. The comment's "Fixes pushed" section
  cites the short SHAs.

---

COMMENT RULE:
- Post exactly one plain comment: gh pr comment ${prNumber} --repo ${nwo} --body-file ${artifactsDir}/summary.md
- Do NOT run gh pr review. No inline line comments in v1.

---

WORKFLOW — follow this order exactly:

1. READ THE IMPACT REPORT.
   Check if ${artifactsDir}/pr-impact.md exists. If yes, read it — this is
   your primary lens. Note the Touched Zones, Risks per Memory, Memory Gaps.
   If absent (impact stage failed), note this and proceed with the full memory
   block above as your only context.

2. READ THE PR.
   Read ${artifactsDir}/pr-context.json and ${artifactsDir}/pr.diff in full.

3. PLAN THE REVIEW.
   Write ${artifactsDir}/review-plan.json:
   {
     "groups": [
       {
         "id": "group-01",
         "files": ["src/a.ts", "src/a.test.ts"],
         "dimensions": ["correctness", "style"],
         "focus": "paragraph distilled from pr-impact.md: which memory-recorded
                   invariants apply here, which risks land here, any memory gaps.
                   If the impact report is missing, write your own focus paragraph."
       },
       ...
     ],
     "skipped": ["package-lock.json"],
     "focus_notes": "one paragraph: what the PR does and where the risk surface is"
   }
   Rules:
   - Group related files (implementation + test) together.
   - 2 files per group typical; at most 10 groups. For large PRs, cover the
     highest-churn groups and list the rest in skipped.
   - Always skip: lockfiles, generated code, vendored deps, large data migrations.
   - Every group MUST have a non-empty focus string.

4. SPAWN A FLEET OF SUBAGENTS.
   Use the pi-subagents tool to launch ALL of the following in parallel:

   a) One FILE-GROUP subagent per group. Use this prompt template:
      ---
      You are reviewing a slice of a pull request. Read-only.
      Files assigned: <group.files>
      Dimensions: <group.dimensions>
      FOCUS (from the repo's memory and PR impact report — your primary lens):
      <group.focus>
      The full diff is at ${artifactsDir}/pr.diff; your files' hunks are inside it.
      You MAY open adjacent files in the worktree to understand callers/imports.
      You may NOT edit anything.
      Produce a report matching the schema below and write it to
      ${artifactsDir}/reports/<group-id>.json. No prose outside the JSON.
      <schema below>
      ---

   b) One HOLISTIC subagent. Use this prompt template:
      ---
      You are the cross-cutting reviewer for this pull request. Read-only.
      Cover: tests (coverage added/updated?), security (authN/Z, secrets,
      injection, unsafe deserialization), cross-cutting concerns (duplicate
      helpers, layering violations, API contract drift).
      Do NOT duplicate file-local correctness or style — those belong to file-group subagents.
      FOCUS (memory gaps the orchestrator flagged):
      <paste the "Memory Gaps" section from pr-impact.md, or "no impact report available">
      Inputs: ${artifactsDir}/pr-context.json, ${artifactsDir}/pr.diff, and any
      files you want to grep/read in the worktree.
      You MAY grep/read any file in the repo. You may NOT edit anything.
      Write your report to ${artifactsDir}/reports/holistic.json.
      <schema below>
      ---

   Subagents do NOT receive the full memory block. You hold that context and
   distill it into the per-group focus strings. Keep subagents lean.

   SUBAGENT REPORT SCHEMA (every subagent must produce this):
   {
     "subagent_id": "group-01" | "holistic",
     "files_reviewed": ["src/..."],
     "dimensions": ["correctness", "style"],
     "issues": [
       {
         "file": "src/...",
         "line_start": 42,
         "line_end": 48,
         "severity": "blocker" | "major" | "minor" | "nit",
         "category": "correctness" | "style" | "tests" | "security",
         "title": "one line",
         "rationale": "why this is an issue",
         "suggested_fix": "prose, not a patch"
       }
     ],
     "notes": ""
   }

5. WAIT FOR ALL SUBAGENTS. Read every report back from ${artifactsDir}/reports/.

6. AGGREGATE.
   - Dedupe issues that appear in multiple reports.
   - Sort by severity (blocker → major → minor → nit).
   - Split into auto-fix bucket (style any severity; correctness minor/nit) and
     flag-only bucket (everything else).

7. APPLY ALL AUTO-FIXABLE ISSUES.
   For each auto-fix issue: open the file in ${worktreePath}, make the fix,
   save. Group into 1–3 logical commits (fix:, style:, refactor:, test:) and
   push to ${branch}. Note the short SHAs.

8. WRITE THE SUMMARY.
   Write ${artifactsDir}/summary.md:

   <one-line verdict: "N fixes pushed; M issues flagged for author.">

   ## Fixes pushed
   - <short-sha> <conventional message> — what it addressed

   ## Issues for author
   - [severity][category] path:line — title. Rationale. Suggested fix.

   ## Skipped files
   - path — reason  (omit section if empty)

9. POST THE COMMENT.
   gh pr comment ${prNumber} --repo ${nwo} --body-file ${artifactsDir}/summary.md

10. End with: {"status": "complete"}

---

This is not optional. You MUST spawn subagents. You MUST commit fixes before
commenting. You MUST post the comment. A review that only reads and reports
without fixing and commenting is incomplete.`;
}

export function prAnalystInitialPrompt(artifactsDir: string): string {
  return `Begin the PR review. Check for ${artifactsDir}/pr-impact.md first (your primary lens), then read ${artifactsDir}/pr-context.json and ${artifactsDir}/pr.diff. Plan, fan out your subagents, wait for all reports, aggregate, fix everything auto-fixable, commit and push, then post the summary comment. Follow the workflow in order. End with {"status": "complete"}.`;
}
```

### `src/pipelines/pr-review/analyst.ts`

```ts
/**
 * pr_analyst stage. The heavy lifter: reads the PR, fans out a fleet of
 * subagents, aggregates their reports, commits all auto-fixable issues to
 * the PR branch, and posts a single summary comment.
 *
 * Runs as a pi session with pi-subagents capability. Memory is injected at
 * invocation time. Throws on hard failure so the pipeline can failTask.
 */

import { createLogger } from "../../shared/logger.js";
import { loadEnv } from "../../shared/config.js";
import { runStage, type SendTelegram } from "../../core/stage.js";
import { memoryBlock } from "../../shared/agent-prompts.js";
import { subagentCapability } from "../../core/subagents/index.js";
import { prAnalystSystemPrompt, prAnalystInitialPrompt } from "./analyst-prompts.js";

const log = createLogger("pr-analyst");

// Give the analyst plenty of time — it fans out many subagents and applies fixes.
const ANALYST_TIMEOUT_MS = 45 * 60 * 1000;

export interface PrAnalystOptions {
  taskId: string;
  repo: string;
  nwo: string;
  prNumber: number;
  headRef: string;
  artifactsDir: string;
  worktreePath: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
}

/**
 * Run the pr_analyst stage. Throws on failure — pipeline catches and calls failTask.
 */
export async function runPrAnalyst(opts: PrAnalystOptions): Promise<void> {
  const { taskId, repo, nwo, prNumber, headRef, artifactsDir, worktreePath, sendTelegram, chatId } = opts;

  const memory = await memoryBlock(repo);
  const cap = subagentCapability();

  const systemPrompt = memory
    + "\n\n"
    + prAnalystSystemPrompt({ repo, nwo, headRef, prNumber, artifactsDir, worktreePath });

  await runStage({
    taskId,
    stage: "pr_analyst",
    cwd: worktreePath,
    systemPrompt,
    initialPrompt: prAnalystInitialPrompt(artifactsDir),
    model: modelForAnalyst(),
    sendTelegram,
    chatId,
    stageLabel: "PR Analyst",
    timeoutMs: ANALYST_TIMEOUT_MS,
    extensions: cap.extensions,
    envOverrides: cap.envOverrides,
  });

  log.info(`pr_analyst complete for task ${taskId}`);
}

function modelForAnalyst(): string {
  const env = loadEnv();
  return env.PI_MODEL_PR_ANALYST ?? env.PI_MODEL;
}
```

### Config + env

In `src/shared/config.ts`:
```ts
PI_MODEL_PR_ANALYST: z.string().optional(),
```

In `.env.example`:
```
# Model for the pr_analyst stage. Use your best model — it plans, fans out
# subagents, applies fixes, and writes the comment. Falls back to PI_MODEL.
PI_MODEL_PR_ANALYST=
```

**Verify:** `npm run build`

**Commit:** `feat(pr-review): pr_analyst stage — subagent fleet, commit fixes, post comment`

---

## Task 7: Replace the pr-review pipeline stub with the real thin pipeline

**Files:**
- Modify: `src/pipelines/pr-review/pipeline.ts`

Replace the file wholesale. The pipeline is purely orchestration — every heavy operation delegates to a named stage.

```ts
/**
 * PR review pipeline. Thin outer wrapper: syncs the repo, runs memory,
 * fetches PR context, runs the impact stage, then runs the analyst stage
 * which fans out subagents, commits fixes, and posts the summary comment.
 */

import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config } from "../../shared/config.js";
import { getRepo } from "../../shared/repos.js";
import { syncRepo, createPrWorktree, cleanupWorktree } from "../../core/git/worktree.js";
import { getPrMetadata, getPrDiff, parseNwo, parsePrIdentifier } from "../../core/git/github.js";
import { runMemory } from "../memory/pipeline.js";
import { runImpactAnalyzer } from "./impact-analyzer.js";
import { runPrAnalyst } from "./analyst.js";
import { failTask, notifyTelegram, type SendTelegram } from "../../core/stage.js";
import { withPipelineSpan } from "../../observability/index.js";
import * as queries from "../../db/repository.js";

const log = createLogger("pr-review");

export async function runPrReview(taskId: string, sendTelegram: SendTelegram): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) { log.error(`Task ${taskId} not found`); return; }
  return withPipelineSpan(
    { taskId, kind: "pr_review", repo: task.repo },
    () => runPrReviewInner(taskId, task, sendTelegram),
  );
}

async function runPrReviewInner(
  taskId: string,
  task: NonNullable<Awaited<ReturnType<typeof queries.getTask>>>,
  sendTelegram: SendTelegram,
): Promise<void> {
  const chatId = task.telegramChatId;
  const repo = getRepo(task.repo);
  if (!repo) {
    await failTask(taskId, `Repo '${task.repo}' not found in registry`, sendTelegram, chatId);
    return;
  }

  const prNumber = parsePrIdentifier(task.prIdentifier ?? task.description);
  if (!prNumber) {
    await failTask(taskId, `Could not parse PR identifier: ${task.prIdentifier ?? task.description}`, sendTelegram, chatId);
    return;
  }

  const nwo = repo.githubUrl ? parseNwo(repo.githubUrl) : null;
  if (!nwo) {
    await failTask(taskId, `Repo '${task.repo}' is missing a githubUrl`, sendTelegram, chatId);
    return;
  }

  await notifyTelegram(sendTelegram, chatId, `PR review ${task.id.slice(0, 8)} starting for ${nwo}#${prNumber}.`);

  // Fresh artifacts on every (re)run.
  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(path.join(artifactsDir, "reports"), { recursive: true });

  try {
    await syncRepo(repo.localPath);
  } catch (err) {
    await failTask(taskId, `Failed to sync repo: ${err}`, sendTelegram, chatId);
    return;
  }

  // Stage 1: memory. Always runs first. Soft-fail.
  await runMemory({
    taskId,
    repo: task.repo,
    repoPath: repo.localPath,
    source: "task",
    sendTelegram,
    chatId,
  });

  // Fetch PR context before the impact stage so pr.diff is on disk for it.
  let metadata: Awaited<ReturnType<typeof getPrMetadata>>;
  let diff: string;
  let branch: string;
  try {
    metadata = await getPrMetadata(nwo, prNumber);
    diff = await getPrDiff(nwo, prNumber);
    branch = metadata.headRef;
  } catch (err) {
    await failTask(taskId, `Failed to fetch PR context: ${err instanceof Error ? err.message : String(err)}`, sendTelegram, chatId);
    return;
  }
  await writeFile(path.join(artifactsDir, "pr-context.json"), JSON.stringify(metadata, null, 2));
  await writeFile(path.join(artifactsDir, "pr.diff"), diff);

  // Stage 2: pr_impact. Memory-derived synthesis. Soft-fail.
  await runImpactAnalyzer({
    taskId,
    repo: task.repo,
    artifactsDir,
    sendTelegram,
    chatId: chatId ?? null,
  });

  // Create the worktree the analyst will commit from.
  // createPrWorktree now takes headRef and fetches the real branch from origin,
  // so the worktree is directly on the PR branch. git push just works.
  let worktreePath: string;
  try {
    worktreePath = await createPrWorktree(repo.localPath, branch, taskId);
  } catch (err) {
    await failTask(taskId, `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`, sendTelegram, chatId);
    return;
  }

  await queries.updateTask(taskId, { prNumber, status: "running" });

  // Stage 3: pr_analyst. Fans out subagents, commits fixes, posts comment. Throws on failure.
  try {
    await runPrAnalyst({
      taskId,
      repo: task.repo,
      nwo,
      prNumber,
      headRef: branch,  // real PR branch — worktree is checked out to it directly
      artifactsDir,
      worktreePath,
      sendTelegram,
      chatId: chatId ?? null,
    });
    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
  } catch (err) {
    await failTask(taskId, err instanceof Error ? err.message : String(err), sendTelegram, chatId);
  } finally {
    await cleanupWorktree(worktreePath).catch((e) => log.warn(`Worktree cleanup failed: ${e}`));
  }
}
```

**Verify:** `npm run build`

**Commit:** `feat(pr-review): real thin pipeline — memory → pr_impact → pr_analyst`

---

## Task 8: Wire Telegram dispatch

**Files:**
- Modify: `src/telegram/handlers.ts`

Replace:
```ts
case "pr_review":
  return ctx.reply("PR review is not implemented yet.");
```
with:
```ts
case "pr_review":
  return createAndStart(
    { kind: "pr_review", repo: intent.repo, description: intent.prIdentifier, prIdentifier: intent.prIdentifier },
    ctx,
  );
```

**Verify:** `npm run build`

**Commit:** `feat(pr-review): route pr_review intents to the real pipeline`

---

## Task 9: Unit tests

**Files:**
- Create: `tests/unit/shared/pr-review-schemas.test.ts`
- Create: `tests/unit/core/git/pr-context.test.ts`
- Create: `tests/unit/pipelines/pr-review/impact-prompts.test.ts`
- Create: `tests/unit/pipelines/pr-review/analyst-prompts.test.ts`

### `pr-review-schemas.test.ts`

Assert all three schemas accept well-formed inputs and reject:
- unknown category / severity
- missing `line_start` or negative line numbers
- empty `dimensions` array on a report
- empty `files` array on a group
- `focus` omitted defaults to `""`

### `pr-context.test.ts`

Mock `execFile` via `vi.mock("node:child_process")`:
- `getPrMetadata` parses `gh pr view --json` output correctly; missing `body` falls back to `""`; labels and files map
- `getPrDiff` returns raw stdout
- Both throw on non-zero exit

### `impact-prompts.test.ts`

Construct `impactAnalyzerSystemPrompt("o/r", "/tmp/a", "<memory>")` and assert:
- Contains all five section headers (`## Summary`, `## Touched Zones`, `## Affected Symbols & Concepts`, `## Risks per Memory`, `## Memory Gaps`)
- Contains `"IMPACT_ANALYSIS_DONE"` sentinel
- Contains the read-only constraint string
- Contains the memory body verbatim
- Empty memory produces a prompt with `"NO MEMORY AVAILABLE"` fallback
- Does NOT contain any instruction to grep or open source files
- `impactAnalyzerInitialPrompt` references the correct absolute path

### `analyst-prompts.test.ts`

Construct `prAnalystSystemPrompt({ repo: "o/r", nwo: "o/r", headRef: "feature/fix", prNumber: 42, artifactsDir: "/tmp/a", worktreePath: "/tmp/w" })` and assert:
- Contains the auto-fix rule string (`category=style`)
- Contains `gh pr comment 42 --repo o/r`
- Contains `git push origin feature/fix` (direct push — worktree is on the real branch)
- Does NOT contain `gh pr review`
- Contains both subagent template markers (`FILE-GROUP subagent`, `HOLISTIC subagent`)
- Contains `pr-impact.md` reference
- Contains `"Subagents do NOT receive the full memory block"` (context-hiding contract)
- Contains `{"status": "complete"}` end sentinel
- `prAnalystInitialPrompt` references `pr-impact.md`

**Verify:** `npm test`

**Commit:** `test(pr-review): schemas, gh wrappers, impact prompts, analyst prompts`

---

## Task 10: Manual verification

No commit. Required before declaring done (per AGENTS.md definition of done).

1. `npm run dev`
2. Open a small live PR on a registered repo where you have push access.
3. Telegram: `review <PR URL>`
4. Watch in order:
   - `memory` stage runs (cold-builds on first run for the repo).
   - Pipeline writes `artifacts/<taskId>/{pr-context.json, pr.diff}`.
   - `pr_impact` stage runs with cwd = artifactsDir. Confirm `pr-impact.md` appears with all five section headers and no citations the agent couldn't have gotten from memory.
   - `pr_analyst` stage starts in the worktree. Session file shows it reading `pr-impact.md` first, then writing `review-plan.json` with non-empty `focus` on every group.
   - Subagent tool calls appear. Confirm prompts include the distilled focus but NOT the full memory block.
   - `artifacts/<taskId>/reports/*.json` files appear.
   - 1–3 commits land on the PR branch.
   - A single `gh pr comment` appears on the PR with the structured summary.

5. Negative tests:
   - **Failed impact stage:** kill the pi subprocess for `pr_impact`. Confirm the analyst starts anyway, reads the missing-file case, and every group focus says "impact report missing".
   - **Empty memory:** mock `memoryBlock` to return `""`. Confirm the impact stage produces a report where "Memory Gaps" lists every touched file.

6. Reply to the PR comment on GitHub. Verify the poller picks it up and `resumePrSession` runs.

7. Revert or close the test PR before merging.

If any step regresses: stop, surface the log line verbatim, do not paper over with try/catch.

---

## Explicit non-goals for v1

- Inline review comments on specific lines. Punt until line-number drift is solved.
- Fork PRs / PRs where push is denied.
- Dimensions beyond `correctness / style / tests / security`.
- Auto-fix of `major`/`blocker` correctness or any `security` issue.
- Full memory block inside subagent prompts — analyst distills per-group focus; subagents stay lean.
- Removing the `pr-session/` layer for follow-up replies — `resumePrSession` already handles that and is left untouched.
