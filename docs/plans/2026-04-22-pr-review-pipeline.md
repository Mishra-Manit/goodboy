# PR Review Pipeline Implementation Plan

**Goal:** Turn `pr_review` from a stub into a real pipeline: one pi session with subagent capability that plans a review, fans out to N file-group subagents + 1 holistic subagent, aggregates reports, auto-fixes the safe issues with commits pushed back to the PR, and posts a single summary comment.

**Approach:** Thin outer pipeline in `pr-review/pipeline.ts` does repo sync + worktree + `gh` context fetch, runs the impact analyzer, then hands off to the existing `startExternalReview` machinery in `pr-session/session.ts`. The real change is (a) a new `pr_impact_analyzer` stage that produces a structured blast-radius report before the orchestrator starts, (b) passing `subagentCapability()` into that session, and (c) rewriting the review prompt into an orchestrator that reads the impact report, spawns subagents, enforces a Zod-validated report schema, applies an auto-fix vs flag-only rule, and posts via `gh pr comment`. All downstream infra (session file, poller, `resumePrSession` for human replies) is untouched.

**Stack:** TypeScript + pi-RPC (`runStage`), pi-subagents extension (same as coding planner), `gh` CLI, Zod at every trust boundary, one additive DB migration for the `pr_impact_analyzer` stage name.

---

## Locked invariants (from brainstorming)

1. **Same-repo (always commit-back).** Fork PRs are out of scope for v1.
2. **One writer, many readers.** Main agent edits files; subagents are read-only and return structured JSON reports only.
3. **Fan-out:** N file-group subagents (N = `ceil(changedFiles / 2)`, capped at 10) covering `correctness` + `style`. Plus 1 holistic subagent covering `tests` + `security` + cross-cutting.
4. **Auto-fix rule:** `style` at any severity and `correctness` at `minor`/`nit` are auto-fixed. `correctness` at `major`/`blocker`, any `security`, and anything needing a design choice are flag-only.
5. **Output:** one `gh pr comment` summary. No `gh pr review --approve/--request-changes`. No inline line comments in v1.
6. **Context source:** `AGENTS.md` (+ `CLAUDE.md` if present) from the worktree. Memory system plugs in later via `memoryBlock(repo)`.
7. **Follow-up:** humans reply to the summary → existing poller + `resumePrSession` loop handles it.
8. **Subagent capability stays on** in resumed turns.
9. **Impact analyzer always runs first for `pr_review`.** It is soft-fail — the review proceeds without `pr-impact.md` if the stage fails or times out. Its implementation is isolated behind `runImpactAnalyzer` so the underlying approach (LLM now, RAG or call graph later) can be swapped without touching the pipeline. The output contract (section headers in `pr-impact.md`) is fixed regardless of implementation.

---

## File layout

```
src/
  shared/types.ts                                  MODIFIED: PrReviewIssue, PrReviewReport, PrReviewPlan
                                                             Zod schemas + pr_impact_analyzer stage name
  db/schema.ts                                     MODIFIED: stageNameEnum
  core/git/github.ts                               MODIFIED: getPrMetadata, getPrDiff helpers
  pipelines/pr-review/pipeline.ts                  MODIFIED: stub -> real thin pipeline + runImpactAnalyzer call
  pipelines/pr-review/impact-analyzer.ts           NEW: runImpactAnalyzer (swappable entry point, LLM-backed)
  pipelines/pr-review/impact-prompts.ts            NEW: impactAnalyzerSystemPrompt, impactAnalyzerInitialPrompt
  pipelines/pr-session/prompts.ts                  MODIFIED: rewrite review-mode prompt + step 2b for pr-impact.md
  pipelines/pr-session/session.ts                  MODIFIED: pass subagentCapability() into review turn
  telegram/handlers.ts                             MODIFIED: remove pr_review short-circuit, route to createAndStart
drizzle/
  0005_pr_impact_stage.sql                         NEW: generated migration
tests/
  unit/shared/pr-review-schemas.test.ts            NEW
  unit/core/git/pr-context.test.ts                 NEW
  unit/pipelines/pr-review/impact-prompts.test.ts  NEW
  unit/pipelines/pr-review-prompts.test.ts         NEW
```

`TASK_KINDS` already includes `pr_review`; `STAGE_NAMES` already includes `pr_reviewing`. The only schema addition is `pr_impact_analyzer`.

---

## Task 1: Add `pr_impact_analyzer` to stage registry + generate migration

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/db/schema.ts`

In `shared/types.ts`, add `"pr_impact_analyzer"` to `STAGE_NAMES`:

```ts
export const STAGE_NAMES = [
  "memory_maintainer",
  "planner", "implementer", "reviewer", "pr_creator", "revision",
  "answering",
  "pr_impact_analyzer",
  "pr_reviewing",
] as const;
```

Mirror in `db/schema.ts`'s `stageNameEnum`.

Then generate the migration:

```bash
npm run db:generate
```

This produces `drizzle/0005_pr_impact_stage.sql` — an additive `ALTER TYPE ... ADD VALUE`. Do NOT `db:migrate` yet — human applies from laptop before the code that reads the new value merges.

**Verify:** `npm run build` clean.

**Commit:** `feat(pr-review): add pr_impact_analyzer stage name + drizzle migration`

---

## Task 2: Add Zod schemas for the PR review contract

**Files:**
- Modify: `src/shared/types.ts`

**Implementation:**

Append a new section. Keep existing sections untouched.

```ts
// --- PR review contract ---

import { z } from "zod";

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
  })),
  skipped: z.array(z.string()),
  focus_notes: z.string(),
});
export type PrReviewPlan = z.infer<typeof prReviewPlanSchema>;
```

**Verify:**
```bash
npm run build
```

**Commit:** `feat(pr-review): add zod schemas for review plan and subagent reports`

---

## Task 3: gh CLI helpers for PR context

**Files:**
- Modify: `src/core/git/github.ts`

**Implementation:**

Add to the `// --- gh CLI wrappers ---` section. Keep the pure-parsers section on top.

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

/** Fetch PR metadata needed for the review orchestrator prompt. Throws on failure. */
export async function getPrMetadata(nwo: string, prNumber: number): Promise<PrMetadata> {
  const { stdout } = await exec("gh", [
    "pr", "view", String(prNumber),
    "--repo", nwo,
    "--json", "number,title,body,labels,author,baseRefName,headRefName,files",
  ]);
  const data = JSON.parse(stdout) as {
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    author: { login: string };
    baseRefName: string;
    headRefName: string;
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

**Verify:**
```bash
npm run build
# manual: gh pr view <n> --repo ... --json number,title,... should match the shape above
```

**Commit:** `feat(pr-review): add getPrMetadata and getPrDiff gh wrappers`

---

## Task 4: Impact analyzer prompts + implementation

**Files:**
- Create: `src/pipelines/pr-review/impact-prompts.ts`
- Create: `src/pipelines/pr-review/impact-analyzer.ts`
- Modify: `src/shared/config.ts` (add `PI_MODEL_PR_IMPACT`)
- Modify: `.env.example`

### `src/pipelines/pr-review/impact-prompts.ts`

```ts
/**
 * Prompts for the pr_impact_analyzer stage. The LLM agent reads the PR diff
 * and explores the worktree to produce a structured impact report before the
 * review orchestrator starts. The section contract in pr-impact.md is fixed —
 * swapping the implementation (RAG, call graph) does not change these headers.
 */

export function impactAnalyzerSystemPrompt(repo: string, artifactsDir: string): string {
  return `You are the PR Impact Analyzer for "${repo}".

Your job is to produce a deep, structured impact report for a pull request BEFORE
the review agents start. The review orchestrator will read your report to make better
grouping and flagging decisions. Be thorough — this is the most valuable context
the reviewer will receive.

INPUTS (already written to disk):
  ${artifactsDir}/pr-context.json  — PR metadata: title, body, labels, changed file list
  ${artifactsDir}/pr.diff          — full unified diff

YOUR TASK:
1. Read pr-context.json and pr.diff in full.
2. Read every changed file in the worktree in full (not just the diff hunks).
3. For each exported function, type, class, or constant that was added, removed,
   or modified: grep the entire worktree to find all call sites and references
   outside the diff. Use: git grep -n --word-regexp "<symbol>" -- "*.ts" "*.tsx"
4. Reason about semantic blast radius — behavioral changes that grep cannot find:
   - Functions that now return null/undefined in new cases
   - Error contract changes (new throws, changed error types)
   - Type changes that cascade through generics or discriminated unions
   - Interface changes that silently break implementations elsewhere
5. Identify test coverage gaps: which test files exist for changed modules but
   do not exercise the new or changed code paths.
6. Read AGENTS.md (and CLAUDE.md if present) and flag any architecture violations:
   layering rules broken, banned patterns introduced, naming conventions violated.
7. Write your full report to ${artifactsDir}/pr-impact.md using EXACTLY these
   section headers in this order. Write every header even if a section is empty
   — in that case write "None identified." under it.

   # Impact Analysis — PR #<number>: <title>

   ## Summary
   One paragraph. What this PR fundamentally changes, where the blast radius is,
   and the single biggest risk area.

   ## Changed Symbols
   Bullet list. For each changed export: name, kind (function/type/class/const),
   file [path:line], and one-line description of how it changed.

   ## Cross-File Blast Radius
   For each changed symbol that has callers or references outside the diff:
   list the symbol name, then a sub-list of affected files with line numbers and
   a one-line assessment of whether those call sites are safe given the change.
   Omit symbols that are only referenced inside the diff.

   ## Semantic Risks
   Behavioral changes not visible from grep alone. Null cases introduced, error
   contract changes, type cascade failures, silent runtime breakage in callers.
   Cite the specific file and line [path:line] for every risk.

   ## Test Coverage Gaps
   Which test files cover the changed modules and which new code paths are NOT
   exercised by any existing test. Name the untested code path, not just the file.

   ## Architecture Concerns
   Violations of AGENTS.md rules found in the PR. Quote the rule and cite the
   violating line [path:line]. If none, write "None identified."

CONSTRAINTS:
- You are READ-ONLY with respect to the worktree. Do NOT edit, create, or delete
  any file in the repo.
- You MAY ONLY write to ${artifactsDir}/pr-impact.md.
- Every concrete claim must cite its source [path:line]. No speculation.
- The six section headers above are a fixed contract — do not rename or reorder them.

When done, end your output with "IMPACT_ANALYSIS_DONE".`;
}

export function impactAnalyzerInitialPrompt(artifactsDir: string): string {
  return `Begin the impact analysis. Read ${artifactsDir}/pr-context.json and ${artifactsDir}/pr.diff first, then explore the worktree. Write the complete report to ${artifactsDir}/pr-impact.md covering all six sections. Do not stop until every section header is written.`;
}
```

### `src/pipelines/pr-review/impact-analyzer.ts`

```ts
/**
 * PR impact analyzer stage. Runs an LLM agent to produce a structured blast-radius
 * report (pr-impact.md) before the review orchestrator starts. Soft-fails always —
 * the review pipeline proceeds without the report if this stage fails or times out.
 *
 * The underlying approach (LLM now, RAG or call graph later) is swappable without
 * touching the pipeline — only this file changes.
 */

import { createLogger } from "../../shared/logger.js";
import { loadEnv } from "../../shared/config.js";
import { runStage, type SendTelegram } from "../../core/stage.js";
import { impactAnalyzerSystemPrompt, impactAnalyzerInitialPrompt } from "./impact-prompts.js";

const log = createLogger("pr-impact-analyzer");

const IMPACT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ImpactAnalyzerOptions {
  taskId: string;
  repo: string;
  repoPath: string;
  artifactsDir: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
}

/**
 * Run the impact analyzer for a PR review task. Always soft-fails — never throws
 * and never propagates failure to the caller. Writes `<artifactsDir>/pr-impact.md`
 * on success; leaves it absent on failure so the orchestrator can detect the
 * missing-file case gracefully.
 */
export async function runImpactAnalyzer(opts: ImpactAnalyzerOptions): Promise<void> {
  const { taskId, repo, repoPath, artifactsDir, sendTelegram, chatId } = opts;
  try {
    await runStage({
      taskId,
      stage: "pr_impact_analyzer",
      cwd: repoPath,
      systemPrompt: impactAnalyzerSystemPrompt(repo, artifactsDir),
      initialPrompt: impactAnalyzerInitialPrompt(artifactsDir),
      model: modelForImpactAnalysis(),
      sendTelegram,
      chatId,
      stageLabel: "PR Impact Analysis",
      timeoutMs: IMPACT_TIMEOUT_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Impact analyzer failed for task ${taskId}: ${message} — proceeding without report`);
  }
}

function modelForImpactAnalysis(): string {
  const env = loadEnv();
  return env.PI_MODEL_PR_IMPACT ?? env.PI_MODEL;
}
```

### Config + env

In `src/shared/config.ts`, add:
```ts
PI_MODEL_PR_IMPACT: z.string().optional(),
```

In `.env.example`:
```
# Model for PR impact analyzer. Falls back to PI_MODEL.
PI_MODEL_PR_IMPACT=
```

**Implementation note:** The impact analyzer runs with `cwd: repo.localPath` (the main checkout), not a worktree. The worktree does not exist yet at this point in the pipeline — `startExternalReview` creates it. The analyzer only needs to read files and grep for references, which the main checkout provides. The diff is already captured at an absolute path in `artifactsDir`, so the agent can reference it directly regardless of cwd.

**Verify:** `npm run build` clean.

**Commit:** `feat(pr-review): LLM-backed impact analyzer stage with swappable interface`

---

## Task 5: Rewrite the review-mode prompts

**Files:**
- Modify: `src/pipelines/pr-session/prompts.ts`

**Implementation:**

Keep `mode: "own"` untouched. Replace the `mode: "review"` branch and replace `externalReviewPrompt` with an orchestrator prompt that references artifact paths (the pipeline writes them before the session starts).

```ts
// in prSessionPrompt, mode === "review" branch:
return `${shared}
MODE: You are reviewing PR #${prNumber} on ${repo}. You own this review end to end.

RULES OF ENGAGEMENT (non-negotiable):
- You have the pi-subagents tool. Use it. Do NOT attempt to review large PRs alone.
- One writer: you. Subagents are read-only. They return JSON reports; you apply fixes.
- Always commit-back: for fixes you apply, commit (conventional prefix, 1-3 logical commits) and push to ${branch}. Never --force.
- Auto-fix vs flag-only: fix locally only for category=style (any severity) or category=correctness severity in {minor, nit}. EVERYTHING else (major/blocker correctness, any security, anything requiring a design choice) goes into the summary as "for author to address" -- do NOT touch that code.
- Do NOT run gh pr review. Post a single plain issue comment with gh pr comment.

WORKFLOW:
1. Read AGENTS.md and CLAUDE.md (if present) from the worktree.
2. Read ${artifactsDir}/pr-context.json (metadata) and ${artifactsDir}/pr.diff (unified diff).
2b. Read ${artifactsDir}/pr-impact.md if it exists. This is a pre-computed blast-radius
    report written before you started. Use it when forming file groups:
    - Pull caller files from "Cross-File Blast Radius" into the relevant group if the
      report flags them as risky call sites.
    - Treat entries in "Semantic Risks" as pre-identified issues; include them in your
      aggregation step rather than re-discovering them.
    - Treat entries in "Architecture Concerns" as pre-identified flag-only issues.
    If the file does not exist (analyzer failed), proceed without it.
3. Plan the review. Write ${artifactsDir}/review-plan.json matching this shape:
   {
     "groups": [
       { "id": "group-01", "files": ["src/a.ts", "src/a.test.ts"], "dimensions": ["correctness", "style"] },
       ...
     ],
     "skipped": ["package-lock.json", "dist/*"],
     "focus_notes": "one paragraph: what this PR does, where the risky surface is"
   }
   Rules for planning:
   - Group related files (implementation + its test) in the same group, not alphabetical.
   - 2 files per group typical; at most 10 groups. Larger PRs: cover highest-churn groups, list the rest in skipped.
   - Always skip: lockfiles, generated code, vendored deps, massive data migrations.
4. Spawn subagents via the pi-subagents tool:
   - One FILE-GROUP subagent per group. Its job: review those files for correctness + style. It returns JSON per the PrReviewReport schema (see below). It writes its report to ${artifactsDir}/reports/<group-id>.json.
   - One HOLISTIC subagent. Its job: cover tests + security + cross-cutting concerns over the whole PR. It writes ${artifactsDir}/reports/holistic.json.
5. Wait for all subagents to complete. Read every report back.
6. Aggregate: dedupe issues that appear in multiple reports, sort by severity, split into auto-fix and flag-only buckets per the rule above.
7. Apply the auto-fixable issues. Commit in 1-3 logical commits (feat:/fix:/refactor:/style:/test:). Push.
8. Post a single summary via: gh pr comment ${prNumber} --repo ${repo} --body-file ${artifactsDir}/summary.md
9. Write the body yourself into ${artifactsDir}/summary.md first. Structure:
     Line 1: one-line verdict ("N fixes pushed; M issues flagged for author.")
     ## Fixes pushed
     - <short-sha> <conventional message> -- what it addressed
     ## Issues for author
     - [severity] path:line -- title. rationale. suggested fix.
     ## Skipped files
     - path -- reason (only if non-empty)
10. End with: {"status": "complete"}

SUBAGENT REPORT SCHEMA (every subagent MUST produce this):
{
  "subagent_id": "group-01" | "holistic",
  "files_reviewed": ["src/..."],
  "dimensions": ["correctness", "style"],   // or ["tests", "security"] for holistic
  "issues": [
    {
      "file": "src/...",
      "line_start": 42,
      "line_end": 48,
      "severity": "blocker" | "major" | "minor" | "nit",
      "category": "correctness" | "style" | "tests" | "security",
      "title": "one line",
      "rationale": "why this is an issue; cite AGENTS.md when possible",
      "suggested_fix": "prose, not a patch"
    }
  ],
  "notes": ""
}

SUBAGENT PROMPT TEMPLATES (use these verbatim when spawning):

[FILE-GROUP SUBAGENT]
You are reviewing a slice of a pull request. Read-only.
Files assigned: <group.files>
Dimensions to cover: <group.dimensions>
AGENTS.md and CLAUDE.md are at the repo root -- read them for house style.
The full diff is at ${artifactsDir}/pr.diff; your files' hunks are inside it.
You MAY open adjacent files to understand callers/imports. You may NOT edit anything.
Produce a report strictly matching the schema above and write it to ${artifactsDir}/reports/<your-group-id>.json.
Do not include prose outside the JSON file.

[HOLISTIC SUBAGENT]
You are the cross-cutting reviewer for this pull request. Read-only.
Cover: tests (is coverage added/updated?), security (authN/Z, secrets, injection, unsafe deserialization), and cross-cutting concerns (does this new code duplicate existing helpers? does it violate the repo's layering rules per AGENTS.md?).
Do NOT duplicate file-local correctness or style issues -- those belong to the file-group subagents.
Inputs: ${artifactsDir}/pr-context.json (metadata, changed file list, labels), ${artifactsDir}/pr.diff (full diff), AGENTS.md, CLAUDE.md.
If ${artifactsDir}/pr-impact.md exists, read its "Cross-File Blast Radius" and "Architecture Concerns" sections first — use them to focus your review rather than re-discovering the same issues.
You MAY grep/read any file in the repo. You may NOT edit anything.
Write your report to ${artifactsDir}/reports/holistic.json matching the schema above.
`;
```

And the exported initial prompt:

```ts
/** Initial prompt for an external PR review turn. Points the orchestrator at the artifact files the pipeline wrote. */
export function externalReviewPrompt(artifactsDir: string): string {
  return `Begin the review. Start by reading AGENTS.md and ${artifactsDir}/pr-context.json, then ${artifactsDir}/pr.diff and ${artifactsDir}/pr-impact.md (if present). Plan, fan out, aggregate, fix, push, and comment per the workflow. End with {"status": "complete"}.`;
}
```

**Verify:**
```bash
npm run build
```

**Commit:** `feat(pr-review): orchestrator prompt with impact report integration, subagent templates, and auto-fix rule`

---

## Task 6: Pass subagent capability into the external-review turn

**Files:**
- Modify: `src/pipelines/pr-session/session.ts`

**Implementation:**

Import `subagentCapability` at the top:
```ts
import { subagentCapability } from "../../core/subagents/index.js";
```

In `startExternalReview`, extend the `runSessionTurn` call site (and only that one) with the capability. The simplest path is to thread optional `extensions` + `envOverrides` into the `SessionTurn` interface and `spawnPiSession` call.

Change the `SessionTurn` interface:
```ts
interface SessionTurn {
  prSessionId: string;
  labelSuffix: string;
  cwd: string;
  systemPrompt: string;
  model: string;
  prompt: string;
  run: { id: string };
  timeoutLabel: string;
  extensions?: string[];
  envOverrides?: Record<string, string>;
}
```

In `runSessionTurnInner`, pass them to `spawnPiSession`:
```ts
const session = spawnPiSession({
  id: `pr-session-${prSessionId.slice(0, 8)}-${labelSuffix}`,
  cwd,
  systemPrompt,
  model,
  sessionPath: filePath,
  extensions: turn.extensions,
  envOverrides: turn.envOverrides,
});
```
(If `spawnPiSession` doesn't already accept those, check `core/pi/spawn.ts` — the coding pipeline's `runStage` already passes them through, so the plumbing exists. If the direct `spawnPiSession` path doesn't, add the two optional fields and forward them.)

In `startExternalReview`, change the `runSessionTurn({...})` call to include:
```ts
const cap = subagentCapability();
await runSessionTurn({
  prSessionId: prSession.id,
  labelSuffix: "review",
  cwd: worktreePath,
  systemPrompt: prSessionPrompt({ mode: "review", repo: nwo ?? repo, branch, prNumber, artifactsDir }),
  model: modelFor("PI_MODEL_REVIEWER"),
  prompt: externalReviewPrompt(artifactsDir),
  run,
  timeoutLabel: "PR session (external review)",
  extensions: cap.extensions,
  envOverrides: cap.envOverrides,
});
```

Leave `resumePrSession` alone for now — it will reuse the sessionfile which already has subagent tool calls in its history. If you want the resumed turn to still have the capability available, pass the same `cap` there too (low cost, recommended). Add the same `extensions`/`envOverrides` args to that `runSessionTurn` call.

**Verify:**
```bash
npm run build
```

**Commit:** `feat(pr-review): load pi-subagents capability into external review sessions`

---

## Task 7: Replace the pr-review pipeline stub with the real thin pipeline

**Files:**
- Modify: `src/pipelines/pr-review/pipeline.ts`

**Implementation:**

Replace the file wholesale:

```ts
/**
 * PR review pipeline. Thin outer wrapper: syncs the repo, fetches PR context,
 * runs the impact analyzer, then hands off to `startExternalReview` which runs
 * the orchestrator session with pi-subagents capability.
 */

import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config } from "../../shared/config.js";
import { getRepo } from "../../shared/repos.js";
import { syncRepo } from "../../core/git/worktree.js";
import { getPrMetadata, getPrDiff, parseNwo, parsePrIdentifier } from "../../core/git/github.js";
import { runImpactAnalyzer } from "./impact-analyzer.js";
import { startExternalReview } from "../pr-session/session.js";
import { failTask, notifyTelegram, type SendTelegram } from "../../core/stage.js";
import { withPipelineSpan } from "../../observability/index.js";
import * as queries from "../../db/queries.js";

const log = createLogger("pr-review");

/** Entry point for pr_review tasks. Errors surface via `failTask`; never throws. */
export async function runPrReview(taskId: string, sendTelegram: SendTelegram): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) {
    log.error(`Task ${taskId} not found`);
    return;
  }

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
  if (!repo) return void failTask(taskId, `Repo '${task.repo}' not found in registry`, sendTelegram, chatId);

  const identifier = task.prIdentifier ?? task.description;
  const prNumber = parsePrIdentifier(identifier);
  if (!prNumber) return void failTask(taskId, `Could not parse PR identifier: ${identifier}`, sendTelegram, chatId);

  const nwo = repo.githubUrl ? parseNwo(repo.githubUrl) : null;
  if (!nwo) return void failTask(taskId, `Repo '${task.repo}' is missing a githubUrl; cannot resolve nwo`, sendTelegram, chatId);

  await notifyTelegram(sendTelegram, chatId, `PR review ${task.id.slice(0, 8)} starting for ${nwo}#${prNumber}.`);

  // Fresh artifacts on every (re)run.
  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(path.join(artifactsDir, "reports"), { recursive: true });

  try {
    await syncRepo(repo.localPath);
  } catch (err) {
    return void failTask(taskId, `Failed to sync repo: ${err}`, sendTelegram, chatId);
  }

  // Fetch PR context and stage it into artifacts so the orchestrator prompt
  // can point at stable absolute paths.
  let metadata: Awaited<ReturnType<typeof getPrMetadata>>;
  let diff: string;
  try {
    metadata = await getPrMetadata(nwo, prNumber);
    diff = await getPrDiff(nwo, prNumber);
  } catch (err) {
    return void failTask(taskId, `Failed to fetch PR context: ${err instanceof Error ? err.message : String(err)}`, sendTelegram, chatId);
  }
  await writeFile(path.join(artifactsDir, "pr-context.json"), JSON.stringify(metadata, null, 2));
  await writeFile(path.join(artifactsDir, "pr.diff"), diff);

  // Run impact analyzer before the review orchestrator starts. Always soft-fails —
  // the review proceeds without pr-impact.md if this stage fails or times out.
  await runImpactAnalyzer({
    taskId,
    repo: task.repo,
    repoPath: repo.localPath,
    artifactsDir,
    sendTelegram,
    chatId: chatId ?? null,
  });

  await queries.updateTask(taskId, { prNumber, status: "running" });

  // Hand off. The PR session owns the rest of the lifecycle.
  try {
    await startExternalReview({
      repo: task.repo,
      prNumber,
      artifactsDir,
      sendTelegram,
      chatId: chatId ?? "",
      taskId,
    });
    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
  } catch (err) {
    await failTask(taskId, err instanceof Error ? err.message : String(err), sendTelegram, chatId);
  }
}
```

**Implementation note:** `startExternalReview` creates the worktree internally via `createPrWorktree`. The impact analyzer runs before that call, using `repo.localPath` (the main checkout) as its cwd. This is correct — the analyzer reads existing repo files to find callers; it does not need to be on the PR branch. The diff is captured in `artifactsDir` at an absolute path.

`startExternalReview` gains an `artifactsDir: string` field in its options interface so the prompt builder and initial prompt can reference absolute paths instead of `artifacts/...` relative paths. Thread `artifactsDir` from here through `startExternalReview` down to `prSessionPrompt` and `externalReviewPrompt`.

**Verify:**
```bash
npm run build
```

**Commit:** `feat(pr-review): real thin pipeline with impact analyzer + context hand-off to external review`

---

## Task 8: Wire Telegram dispatch

**Files:**
- Modify: `src/telegram/handlers.ts`

**Implementation:**

In `handleIntent`, replace:
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

`createAndStart` already forwards `prIdentifier` to `queries.createTask`, so no further change there. The `PIPELINES` map already routes `pr_review` to `runPrReview`.

**Verify:**
```bash
npm run build
# manual, once all tasks land:
# Telegram: "review https://github.com/<owner>/<repo>/pull/123"
# Expect: "PR review queued: <id>" then within a few minutes a comment on the PR.
```

**Commit:** `feat(pr-review): route pr_review intents to the real pipeline`

---

## Task 9: Unit tests

**Files:**
- Create: `tests/unit/shared/pr-review-schemas.test.ts`
- Create: `tests/unit/core/git/pr-context.test.ts`
- Create: `tests/unit/pipelines/pr-review/impact-prompts.test.ts`
- Create: `tests/unit/pipelines/pr-review-prompts.test.ts`

**Implementation:**

**`pr-review-schemas.test.ts`** — assert `prReviewIssueSchema`, `prReviewReportSchema`, `prReviewPlanSchema` accept a well-formed example and reject:
- unknown category / severity
- missing `line_start` or negative numbers
- empty `dimensions` array on a report
- empty `groups[].files` array
- well-formed JSON with extra fields (should pass; schemas use default parse)

**`pr-context.test.ts`** — mock `execFile` via `vi.mock("node:child_process")`:
- `getPrMetadata` parses `gh pr view --json ...` output into `PrMetadata`; label and file arrays map correctly; missing `body` falls back to `""`.
- `getPrDiff` returns raw stdout.
- Both throw on non-zero exit.

**`impact-prompts.test.ts`** — construct `impactAnalyzerSystemPrompt("o/r", "/tmp/artifacts")`:
- contains all six required section headers (`## Summary`, `## Changed Symbols`, `## Cross-File Blast Radius`, `## Semantic Risks`, `## Test Coverage Gaps`, `## Architecture Concerns`)
- contains the `"IMPACT_ANALYSIS_DONE"` sentinel
- contains the read-only constraint string
- does NOT contain any instruction to edit or create files in the repo
- `impactAnalyzerInitialPrompt("/tmp/artifacts")` references the correct absolute path

**`pr-review-prompts.test.ts`** — construct `prSessionPrompt({ mode: "review", repo: "o/r", branch: "main", prNumber: 42, artifactsDir: "/tmp/a" })`:
- contains the auto-fix rule string (search for `category=style`)
- contains `gh pr comment 42 --repo o/r`
- does NOT contain `gh pr review` anywhere
- contains both subagent template markers (`[FILE-GROUP SUBAGENT]` and `[HOLISTIC SUBAGENT]`)
- contains `pr-impact.md` reference in the workflow section

**Verify:**
```bash
npm test
```

**Commit:** `test(pr-review): schemas, gh wrappers, impact prompts, and orchestrator prompt`

---

## Task 10: Manual verification

No commit for this task. Definition of Done requires manual run per AGENTS.md.

1. `npm run dev`
2. Open a small, live PR on a registered repo where you have push access.
3. Telegram: `review <PR URL>`.
4. Watch dashboard + logs:
   - `pr-review` pipeline creates `artifacts/<taskId>/{pr-context.json, pr.diff}`.
   - `pr_impact_analyzer` stage runs and completes. `artifacts/<taskId>/pr-impact.md` appears with all six section headers populated and citations on every concrete claim.
   - A PR session spawns; sessionfile shows the orchestrator reading `pr-impact.md` then writing `review-plan.json`.
   - Subagent tool calls appear in the sessionfile.
   - `artifacts/<taskId>/review-plan.json` and `artifacts/<taskId>/reports/*.json` appear.
   - 1–3 commits land on the PR branch.
   - A single `gh pr comment` shows up with the structured summary.
5. Negative test: kill the impact analyzer mid-run (SIGKILL the pi subprocess). Confirm the review orchestrator starts anyway and logs `"proceeding without report"`.
6. Reply to the PR comment on GitHub. Verify the poller picks it up and `resumePrSession` runs (the existing loop — no new code in play).
7. Close the PR or revert the commits before merging; this was a test run.

If any step regresses: stop, surface the log line verbatim, do not paper over with try/catch.

---

## Explicit non-goals for v1

- Inline review comments on specific lines (`gh pr review` with line-anchored comments). Punt until line-number drift is solved.
- Fork PRs / PRs where push is denied. Assumed same-repo.
- Memory system integration. Will land separately per `docs/plans/2026-04-22-memory-system.md`.
- Dimensions beyond `correctness / style / tests / security`.
- Auto-fix of `major`/`blocker` correctness or any `security` issue. These always go to the "for author" bucket.
- Swapping the impact analyzer to RAG or call-graph. That is a v2 concern; the interface is ready for it.

---

Plan ready. Want me to start executing now, or do you want to review first?
