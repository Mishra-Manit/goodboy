# PR Review Pipeline Implementation Plan

**Goal:** Turn `pr_review` from a stub into a real pipeline: run the `memory` stage, run a memory-derived `pr_impact_analyzer` stage, then hand off to one pi session with subagent capability that plans a review, fans out to N file-group subagents + 1 holistic subagent, aggregates reports, auto-fixes the safe issues with commits pushed back to the PR, and posts a single summary comment.

**Approach:** Thin outer pipeline in `pr-review/pipeline.ts` does repo sync → `runMemory` → `gh` context fetch → `runImpactAnalyzer`, then hands off to `startExternalReview` in `pr-session/session.ts`. The real changes are:

1. **Integrate the memory system** that landed after this plan was first written: call `runMemory` like `coding` and `question` pipelines do, and inject `memoryBlock(repo)` into the review orchestrator's system prompt (the `pr-review TODO` from commit `6b2f797`).
2. **Memory-derived impact analyzer**: new `pr_impact_analyzer` stage. It has NO repo access — its entire knowledge of the codebase is the injected `memoryBlock(repo)` plus the PR diff. Produces `pr-impact.md`, a PR-scoped pre-filter of memory for the reviewer.
3. **Orchestrator**: the review-mode system prompt is rewritten into a full orchestrator. It receives memory (full repo view) + `pr-impact.md` (PR-scoped pre-filter). It plans, spawns subagents with per-group focus strings distilled from the impact report, aggregates, applies auto-fix-eligible issues, pushes, and posts a single `gh pr comment`.

All downstream infra (session file, poller, `resumePrSession` for human replies, memory run records + SSE events) is untouched.

**Stack:** TypeScript + pi-RPC (`runStage`), pi-subagents extension (same as coding planner), `gh` CLI, Zod at every trust boundary, one additive DB migration for the `pr_impact_analyzer` stage name.

---

## Locked invariants (from brainstorming + memory integration)

1. **Same-repo (always commit-back).** Fork PRs are out of scope for v1.
2. **One writer, many readers.** Main agent edits files; subagents are read-only and return structured JSON reports only.
3. **Fan-out:** N file-group subagents (N = `ceil(changedFiles / 2)`, capped at 10) covering `correctness` + `style`. Plus 1 holistic subagent covering `tests` + `security` + cross-cutting.
4. **Auto-fix rule:** `style` at any severity and `correctness` at `minor`/`nit` are auto-fixed. `correctness` at `major`/`blocker`, any `security`, and anything needing a design choice are flag-only.
5. **Output:** one `gh pr comment` summary. No `gh pr review --approve/--request-changes`. No inline line comments in v1.
6. **Memory always runs first.** `runMemory` is invoked after `syncRepo` and before worktree creation, matching the coding + question pipelines. Soft-fails (never propagates). The resulting memory is injected into every stage prompt that needs it.
7. **Impact analyzer is memory-derived and repo-isolated.** cwd is `artifactsDir` (so `read` sees only `pr.diff` + `pr-context.json`). No grep, no call-site walking, no file opens outside the artifacts directory. Its entire understanding of the codebase comes from the injected `memoryBlock(repo)`. Always runs — even if memory is stale or incomplete, it produces a degraded-but-useful report. Soft-fails like memory: on failure the orchestrator proceeds without `pr-impact.md`.
8. **Impact report is the reviewer's context.** Downstream reviewer gets BOTH `memoryBlock(repo)` (full repo view) and `pr-impact.md` (PR-scoped pre-filter). Only the main orchestrator reads `pr-impact.md`; it distills per-group focus strings into the subagent spawn prompts so the subagents stay lean.
9. **Follow-up:** humans reply to the summary → existing poller + `resumePrSession` loop handles it. `resumePrSession` already injects memory.
10. **Subagent capability stays on** in resumed turns.

---

## What the memory system gives us (already landed)

The following is already in the codebase — this plan depends on it, does not build it:

- `runMemory({ taskId, repo, repoPath, source: "task", sendTelegram, chatId })` in `src/pipelines/memory/pipeline.ts`. Soft-fail.
- `memoryBlock(repo)` in `src/shared/agent-prompts.ts`. Async. Returns `""` if no memory exists yet. Otherwise concatenates `_root/` + every zone's `.md` files into a single prompt block.
- `memory` is already in `STAGE_NAMES`. Memory runs persist to `memory_runs`. `memory_run_update` SSE events stream to the dashboard automatically.
- `resumePrSession` already uses `memory + prSessionPrompt({...})`. The external review turn and the new impact analyzer need the same treatment — that's what this plan adds.

---

## File layout

```
src/
  shared/types.ts                                  MODIFIED: PrReviewIssue, PrReviewReport, PrReviewPlan
                                                             add "pr_impact_analyzer" to STAGE_NAMES
  db/schema.ts                                     MODIFIED: stageNameEnum
  shared/config.ts                                 MODIFIED: add PI_MODEL_PR_IMPACT
  core/git/github.ts                               MODIFIED: getPrMetadata, getPrDiff helpers
  pipelines/pr-review/pipeline.ts                  MODIFIED: stub -> real thin pipeline
                                                             (runMemory -> fetch context -> runImpactAnalyzer -> startExternalReview)
  pipelines/pr-review/impact-analyzer.ts           NEW: runImpactAnalyzer (memory-derived, no repo access)
  pipelines/pr-review/impact-prompts.ts            NEW: impactAnalyzerSystemPrompt, impactAnalyzerInitialPrompt
  pipelines/pr-session/prompts.ts                  MODIFIED: rewrite review-mode prompt (references memory + pr-impact.md)
  pipelines/pr-session/session.ts                  MODIFIED: startExternalReview takes artifactsDir,
                                                             prepends memoryBlock, passes subagentCapability()
  telegram/handlers.ts                             MODIFIED: remove pr_review short-circuit, route to createAndStart
.env.example                                       MODIFIED: PI_MODEL_PR_IMPACT
drizzle/
  <next>_pr_impact_stage.sql                       NEW: generated migration (number follows current sequence)
tests/
  unit/shared/pr-review-schemas.test.ts            NEW
  unit/core/git/pr-context.test.ts                 NEW
  unit/pipelines/pr-review/impact-prompts.test.ts  NEW
  unit/pipelines/pr-review-prompts.test.ts         NEW
```

`TASK_KINDS` already includes `pr_review`; `STAGE_NAMES` already includes `pr_reviewing` and `memory`. The only stage addition is `pr_impact_analyzer`.

---

## Task 1: Add `pr_impact_analyzer` to stage registry + generate migration

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/db/schema.ts`

In `shared/types.ts`, add `"pr_impact_analyzer"` to `STAGE_NAMES`, grouped under the `pr_review` section:

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
  "pr_impact_analyzer",
  "pr_reviewing",
] as const;
```

Mirror in `db/schema.ts`'s `stageNameEnum`.

Then generate the migration:

```bash
npm run db:generate
```

This produces the next-numbered `drizzle/NNNN_pr_impact_stage.sql` — an additive `ALTER TYPE ... ADD VALUE`. Do NOT `db:migrate` yet — human applies from laptop before the code that reads the new value merges.

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
    focus: z.string().default(""),  // distilled from pr-impact.md; empty if analyzer skipped
  })),
  skipped: z.array(z.string()),
  focus_notes: z.string(),
});
export type PrReviewPlan = z.infer<typeof prReviewPlanSchema>;
```

**Verify:** `npm run build`

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

**Verify:** `npm run build`

**Commit:** `feat(pr-review): add getPrMetadata and getPrDiff gh wrappers`

---

## Task 4: Memory-derived impact analyzer

**Files:**
- Create: `src/pipelines/pr-review/impact-prompts.ts`
- Create: `src/pipelines/pr-review/impact-analyzer.ts`
- Modify: `src/shared/config.ts` (add `PI_MODEL_PR_IMPACT`)
- Modify: `.env.example`

### Design

The analyzer is a **pure synthesis step**. Inputs: the repo's injected `memoryBlock(repo)` and the raw unified diff. Outputs: `pr-impact.md` — a PR-scoped pre-filter of memory for the reviewer.

**No repo access.** cwd is `artifactsDir`, so the agent's `read` / `bash` only see `pr.diff` and `pr-context.json`. It cannot open source files, cannot grep the codebase, cannot verify memory claims against live code. This is deliberate: the analyzer's value is that it forces a memory-grounded reasoning pass, and isolates the orchestrator from a giant tool-use preamble.

**No subagents.** One reasoning pass.

**Always runs** — even on stale or missing memory. If `memoryBlock` returns `""`, the prompt notes this and the agent produces a "Memory Gaps" section that flags every touched area as uncovered. If the stage fails (timeout, LLM error), soft-fail: `pr-impact.md` is absent and the orchestrator proceeds without it.

### `src/pipelines/pr-review/impact-prompts.ts`

```ts
/**
 * Prompts for the pr_impact_analyzer stage. A memory-derived synthesis pass:
 * the agent sees ONLY the injected memory block and the PR diff. It has no
 * repo access. Its job is to pre-filter memory down to the parts relevant to
 * this PR and hand the reviewer a tight, PR-scoped context document.
 */

export function impactAnalyzerSystemPrompt(
  repo: string,
  artifactsDir: string,
  memoryBody: string,
): string {
  const memorySection = memoryBody
    ? memoryBody
    : `NO MEMORY AVAILABLE for ${repo}. The codebase memory is empty or failed to
load. Produce the report from the diff alone. Every section will be thin —
that is fine. The "Memory Gaps" section should flag every touched area as
uncovered so the reviewer knows to work harder.`;

  return `You are the PR Impact Analyzer for "${repo}".

Your job: produce a PR-scoped pre-filter of the codebase memory. The review
orchestrator will read your report as its primary lens on this PR. You are
upstream of the reviewer; be tight, structured, and memory-grounded.

WHAT YOU HAVE:
- The full codebase memory (injected below). This is your ONLY view of the
  repository. You cannot open source files. You cannot grep. Do not try.
- The PR's raw unified diff at ${artifactsDir}/pr.diff
- PR metadata (title, body, labels, changed file list) at ${artifactsDir}/pr-context.json

WHAT YOU DO NOT HAVE:
- Access to any file outside ${artifactsDir}. Attempts to read the repo will
  fail silently. Do not attempt them.

${memorySection}

YOUR TASK:
1. Read ${artifactsDir}/pr-context.json and ${artifactsDir}/pr.diff in full.
2. Reason about the diff in light of the memory above. You are NOT rediscovering
   the codebase — the memory already encodes it. Your job is to *project* memory
   onto this specific diff.
3. Write ${artifactsDir}/pr-impact.md using EXACTLY these five section headers
   in this order. If a section has nothing to say, write "None identified." under
   it — do not drop the header.

   # Impact Analysis — PR #<number>: <title>

   ## Summary
   One paragraph. What the PR changes, which memory zones it touches, and the
   single biggest risk area *according to memory*.

   ## Touched Zones
   For every zone (from the memory above) that this PR's changed files fall into:
   zone name, zone summary (quoted verbatim from memory), and the files in this
   PR that land there. If files fall outside every zone, list them under "_root".

   ## Affected Symbols & Concepts
   Exported symbols or architectural concepts the diff changes. For each one,
   cite the memory claim that mentions it (quote the memory line and its
   [path:line] citation). If a changed symbol is not mentioned anywhere in
   memory, list it under "Not in memory" inside this section — that is a signal
   the reviewer will want.

   ## Risks per Memory
   Invariants, patterns, and gotchas the memory records for the touched zones,
   projected onto what the diff does. Format each risk as:
     - [zone] <one-line risk> — memory says: "<quote>" [path:line from memory]
       diff impact: <one-line assessment of whether the diff respects it>
   Only list risks where the diff actually interacts with the memory claim.
   Do not pad.

   ## Memory Gaps
   Places the PR touches that memory does NOT cover well. Be specific: "zone X
   has no overview.md", "memory says nothing about the error-handling pattern
   in src/foo/", "changed file src/bar.ts is outside every zone". This section
   is a signal to the reviewer: "here, you are flying blind — be extra careful."

CONSTRAINTS:
- You are READ-ONLY. You MAY ONLY write to ${artifactsDir}/pr-impact.md.
- Every concrete claim about the repo must cite the memory line it came from
  (memory lines already carry [path:line] citations — reuse them).
- You may NOT cite [path:line] from first-hand file inspection — you cannot
  inspect files. If a memory line doesn't say it, don't claim it.
- The five section headers above are a fixed contract — do not rename or reorder.

When done, end your output with "IMPACT_ANALYSIS_DONE".`;
}

export function impactAnalyzerInitialPrompt(artifactsDir: string): string {
  return `Begin the impact analysis. Read ${artifactsDir}/pr-context.json and ${artifactsDir}/pr.diff, then write the complete ${artifactsDir}/pr-impact.md covering all five sections. Project the memory above onto this specific diff. Do not attempt to read source files — you don't have access. Do not stop until every section header is written.`;
}
```

### `src/pipelines/pr-review/impact-analyzer.ts`

```ts
/**
 * PR impact analyzer stage. Memory-derived synthesis: the agent reads only
 * the injected memory and the PR diff, and produces pr-impact.md — a
 * PR-scoped pre-filter of memory for the review orchestrator. Soft-fails
 * always — the review pipeline proceeds without the report on failure.
 *
 * Intentionally has no repo access (cwd = artifactsDir). When memory is
 * missing, the stage still runs and produces a degraded report.
 */

import { createLogger } from "../../shared/logger.js";
import { loadEnv } from "../../shared/config.js";
import { runStage, type SendTelegram } from "../../core/stage.js";
import { memoryBlock } from "../../shared/agent-prompts.js";
import { impactAnalyzerSystemPrompt, impactAnalyzerInitialPrompt } from "./impact-prompts.js";

const log = createLogger("pr-impact-analyzer");

const IMPACT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ImpactAnalyzerOptions {
  taskId: string;
  repo: string;
  artifactsDir: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
}

/**
 * Run the impact analyzer. Always soft-fails — never throws. Writes
 * `<artifactsDir>/pr-impact.md` on success; leaves it absent on failure so
 * the orchestrator can detect the missing-file case gracefully.
 */
export async function runImpactAnalyzer(opts: ImpactAnalyzerOptions): Promise<void> {
  const { taskId, repo, artifactsDir, sendTelegram, chatId } = opts;
  try {
    const memoryBody = await memoryBlock(repo);
    await runStage({
      taskId,
      stage: "pr_impact_analyzer",
      cwd: artifactsDir,
      systemPrompt: impactAnalyzerSystemPrompt(repo, artifactsDir, memoryBody),
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

In `src/shared/config.ts`, add to the env schema:
```ts
PI_MODEL_PR_IMPACT: z.string().optional(),
```

In `.env.example`:
```
# Model for PR impact analyzer. Use a light, fast model — it's a pure
# memory+diff synthesis pass with no tool use. Falls back to PI_MODEL.
PI_MODEL_PR_IMPACT=
```

**Implementation notes:**
- cwd is `artifactsDir` so `read` sees `pr.diff` + `pr-context.json` and nothing else. The agent cannot open source files — this is the sandbox that makes "memory-derived" real.
- No subagent capability passed — this stage doesn't spawn subagents.
- The stage runs AFTER `runMemory` in the pipeline, so `memoryBlock(repo)` reflects the latest indexed state for this run.

**Verify:** `npm run build`

**Commit:** `feat(pr-review): memory-derived impact analyzer stage (no repo access)`

---

## Task 5: Rewrite the review-mode prompts

**Files:**
- Modify: `src/pipelines/pr-session/prompts.ts`

**Implementation:**

Keep `mode: "own"` untouched. Replace the `mode: "review"` branch and replace `externalReviewPrompt` with an orchestrator prompt. The `artifactsDir` parameter is new. Memory is NOT embedded here — it's prepended at the call site by `startExternalReview`, matching the `resumePrSession` pattern.

```ts
// in prSessionPrompt options: add artifactsDir?: string
// in prSessionPrompt, mode === "review" branch:
return `${shared}
MODE: You are reviewing PR #${prNumber} on ${repo}. You own this review end to end.

RULES OF ENGAGEMENT (non-negotiable):
- You have the pi-subagents tool. Use it. Do NOT attempt to review large PRs alone.
- One writer: you. Subagents are read-only. They return JSON reports; you apply fixes.
- Always commit-back: for fixes you apply, commit (conventional prefix, 1-3 logical commits) and push to ${branch}. Never --force.
- Auto-fix vs flag-only: fix locally only for category=style (any severity) or category=correctness severity in {minor, nit}. EVERYTHING else (major/blocker correctness, any security, anything requiring a design choice) goes into the summary as "for author to address" -- do NOT touch that code.
- Do NOT run gh pr review. Post a single plain issue comment with gh pr comment.

CONTEXT YOU HAVE:
- Codebase memory (the "CODEBASE MEMORY" block above): the full agent-maintained
  knowledge base for this repo. Use it to understand WHY code is written the way
  it is, what patterns the repo follows, and what invariants it holds.
- PR impact report at ${artifactsDir}/pr-impact.md (if present): a memory-derived,
  PR-scoped pre-filter. Start here — it tells you which memory zones and risks are
  actually relevant to this diff. If absent, fall back to the full memory block.
- PR metadata at ${artifactsDir}/pr-context.json and diff at ${artifactsDir}/pr.diff.
- AGENTS.md and CLAUDE.md in the worktree (optional supplement; memory is primary).

WORKFLOW:
1. Read ${artifactsDir}/pr-impact.md if it exists. This is your PR-scoped lens.
   Note the touched zones, memory-grounded risks, and memory gaps. If it does NOT
   exist (analyzer failed), proceed using the full memory block above.
2. Read ${artifactsDir}/pr-context.json and ${artifactsDir}/pr.diff.
3. Plan the review. Write ${artifactsDir}/review-plan.json matching this shape:
   {
     "groups": [
       {
         "id": "group-01",
         "files": ["src/a.ts", "src/a.test.ts"],
         "dimensions": ["correctness", "style"],
         "focus": "one paragraph distilled from pr-impact.md: which memory-recorded invariants apply to these files, which risks from 'Risks per Memory' land here, any 'Memory Gaps' entries for this area. If the impact report is missing, say so here and give your own one-paragraph focus."
       },
       ...
     ],
     "skipped": ["package-lock.json", "dist/*"],
     "focus_notes": "one paragraph: what this PR does and where the risky surface is, grounded in memory"
   }
   Rules for planning:
   - Group related files (implementation + its test) in the same group.
   - 2 files per group typical; at most 10 groups. Larger PRs: cover highest-churn groups, list the rest in skipped.
   - Always skip: lockfiles, generated code, vendored deps, massive data migrations.
   - Every group MUST have a focus string. Don't leave it empty unless the impact
     report is missing AND you have nothing specific to say.
4. Spawn subagents via the pi-subagents tool:
   - One FILE-GROUP subagent per group. Pass its group.focus into the spawn prompt
     verbatim (template below). It reviews those files for correctness + style and
     returns JSON per the PrReviewReport schema. Writes to ${artifactsDir}/reports/<group-id>.json.
   - One HOLISTIC subagent. Covers tests + security + cross-cutting. Pass it the
     "Memory Gaps" section from pr-impact.md (or "no impact report available" if
     it's missing) as its focus. Writes ${artifactsDir}/reports/holistic.json.
   - Subagents do NOT receive the full memory block. You (the orchestrator) hold
     that context and distill it into the per-group focus strings.
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
      "rationale": "why this is an issue",
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
FOCUS (distilled from the repo's memory and the PR impact report — this is
your primary lens; do NOT re-derive it):
<group.focus>
The full diff is at ${artifactsDir}/pr.diff; your files' hunks are inside it.
You MAY open adjacent files in the worktree to understand callers/imports.
You may NOT edit anything.
Produce a report strictly matching the schema above and write it to
${artifactsDir}/reports/<your-group-id>.json. Do not include prose outside the JSON file.

[HOLISTIC SUBAGENT]
You are the cross-cutting reviewer for this pull request. Read-only.
Cover: tests (is coverage added/updated?), security (authN/Z, secrets, injection,
unsafe deserialization), and cross-cutting concerns (duplicate helpers, layering
violations).
Do NOT duplicate file-local correctness or style issues — those belong to the
file-group subagents.
FOCUS (the memory gaps the orchestrator flagged for this PR — places where the
reviewer is flying blind):
<holistic.focus>
Inputs: ${artifactsDir}/pr-context.json, ${artifactsDir}/pr.diff, and any files
in the worktree you want to grep/read.
You MAY grep/read any file in the repo. You may NOT edit anything.
Write your report to ${artifactsDir}/reports/holistic.json matching the schema above.
`;
```

And the exported initial prompt:

```ts
/** Initial prompt for an external PR review turn. Points the orchestrator at the artifact files the pipeline wrote. */
export function externalReviewPrompt(artifactsDir: string): string {
  return `Begin the review. Start by reading ${artifactsDir}/pr-impact.md (if it exists — it's your PR-scoped lens on the repo's memory). Then read ${artifactsDir}/pr-context.json and ${artifactsDir}/pr.diff. Plan, fan out with per-group focus strings, aggregate, fix, push, and comment per the workflow. End with {"status": "complete"}.`;
}
```

**Verify:** `npm run build`

**Commit:** `feat(pr-review): orchestrator prompt with memory + impact-report context and per-group focus`

---

## Task 6: Thread subagent capability + memory + artifactsDir into the external-review turn

**Files:**
- Modify: `src/pipelines/pr-session/session.ts`

**Implementation:**

Import the capability and the memory block at the top:
```ts
import { subagentCapability } from "../../core/subagents/index.js";
import { memoryBlock } from "../../shared/agent-prompts.js";
```

Extend `SessionTurn` with the capability fields. `spawnPiSession` already accepts `extensions` + `envOverrides` (verified in `core/pi/spawn.ts`), so the plumbing just needs to thread them through.

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

In `runSessionTurnInner`, forward them to `spawnPiSession`:
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

Change `startExternalReview`'s signature to take `artifactsDir: string`:
```ts
export async function startExternalReview(options: {
  repo: string;
  prNumber: number;
  artifactsDir: string;      // NEW
  sendTelegram: SendTelegram;
  chatId: string;
  taskId: string;
}): Promise<void> {
```

Then update its `runSessionTurn` call to inject memory + capability + artifactsDir:

```ts
const cap = subagentCapability();
const memory = await memoryBlock(repo);

await runSessionTurn({
  prSessionId: prSession.id,
  labelSuffix: "review",
  cwd: worktreePath,
  systemPrompt: memory + prSessionPrompt({
    mode: "review",
    repo: nwo ?? repo,
    branch,
    prNumber,
    artifactsDir,
  }),
  model: modelFor("PI_MODEL_REVIEWER"),
  prompt: externalReviewPrompt(artifactsDir),
  run,
  timeoutLabel: "PR session (external review)",
  extensions: cap.extensions,
  envOverrides: cap.envOverrides,
});
```

Leave `resumePrSession` alone structurally — it already prepends `memoryBlock`. Optionally add the same `extensions`/`envOverrides` there so the resumed turn keeps subagent capability for follow-up reviews. Recommended, low cost.

**Verify:** `npm run build`

**Commit:** `feat(pr-review): inject memory + subagent capability into external review session`

---

## Task 7: Replace the pr-review pipeline stub with the real thin pipeline

**Files:**
- Modify: `src/pipelines/pr-review/pipeline.ts`

**Implementation:**

Replace the file wholesale. Note: `queries` imports from `../../db/repository.js` (not `db/queries.js`).

```ts
/**
 * PR review pipeline. Thin outer wrapper: syncs the repo, runs the memory
 * stage, fetches PR context, runs the memory-derived impact analyzer, then
 * hands off to `startExternalReview` which runs the orchestrator session
 * with pi-subagents capability and memory injected.
 */

import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config } from "../../shared/config.js";
import { getRepo } from "../../shared/repos.js";
import { syncRepo } from "../../core/git/worktree.js";
import { getPrMetadata, getPrDiff, parseNwo, parsePrIdentifier } from "../../core/git/github.js";
import { runMemory } from "../memory/pipeline.js";
import { runImpactAnalyzer } from "./impact-analyzer.js";
import { startExternalReview } from "../pr-session/session.js";
import { failTask, notifyTelegram, type SendTelegram } from "../../core/stage.js";
import { withPipelineSpan } from "../../observability/index.js";
import * as queries from "../../db/repository.js";

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
  if (!repo) {
    await failTask(taskId, `Repo '${task.repo}' not found in registry`, sendTelegram, chatId);
    return;
  }

  const identifier = task.prIdentifier ?? task.description;
  const prNumber = parsePrIdentifier(identifier);
  if (!prNumber) {
    await failTask(taskId, `Could not parse PR identifier: ${identifier}`, sendTelegram, chatId);
    return;
  }

  const nwo = repo.githubUrl ? parseNwo(repo.githubUrl) : null;
  if (!nwo) {
    await failTask(taskId, `Repo '${task.repo}' is missing a githubUrl; cannot resolve nwo`, sendTelegram, chatId);
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

  // Run the memory stage before anything else. Soft-fail: never throws.
  // Matches the coding + question pipeline pattern. Memory is consumed by
  // the impact analyzer and by the review orchestrator.
  await runMemory({
    taskId,
    repo: task.repo,
    repoPath: repo.localPath,
    source: "task",
    sendTelegram,
    chatId,
  });

  // Fetch PR context and stage it into artifacts so the analyzer and the
  // orchestrator can point at stable absolute paths.
  let metadata: Awaited<ReturnType<typeof getPrMetadata>>;
  let diff: string;
  try {
    metadata = await getPrMetadata(nwo, prNumber);
    diff = await getPrDiff(nwo, prNumber);
  } catch (err) {
    await failTask(taskId, `Failed to fetch PR context: ${err instanceof Error ? err.message : String(err)}`, sendTelegram, chatId);
    return;
  }
  await writeFile(path.join(artifactsDir, "pr-context.json"), JSON.stringify(metadata, null, 2));
  await writeFile(path.join(artifactsDir, "pr.diff"), diff);

  // Run the memory-derived impact analyzer. Soft-fail: on failure, pr-impact.md
  // is absent and the orchestrator proceeds using just the memory block.
  await runImpactAnalyzer({
    taskId,
    repo: task.repo,
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

**Implementation notes:**
- Order: `syncRepo → runMemory → fetch PR context → runImpactAnalyzer → startExternalReview`. Memory must run before the analyzer so the analyzer sees the freshest memory block. PR context fetch runs before the analyzer so `pr.diff` is on disk for it to read.
- The analyzer takes `artifactsDir` only — no `repoPath`. Its cwd is `artifactsDir` (sandboxed).
- `startExternalReview` creates the worktree internally via `createPrWorktree` (already stages subagent assets). The new `artifactsDir` parameter is threaded down to the review system prompt.
- Memory run records + SSE events are handled by `runMemory` itself — no extra wiring needed.

**Verify:** `npm run build`

**Commit:** `feat(pr-review): real thin pipeline with memory, impact analyzer, and context hand-off`

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

`createAndStart` already forwards `prIdentifier`; the `PIPELINES` map already routes `pr_review` to `runPrReview`.

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

**`pr-review-schemas.test.ts`** — assert `prReviewIssueSchema`, `prReviewReportSchema`, `prReviewPlanSchema` accept well-formed examples and reject:
- unknown category / severity
- missing `line_start` or negative numbers
- empty `dimensions` array on a report
- empty `groups[].files` array
- a plan with `focus` omitted should still parse (defaults to `""`)

**`pr-context.test.ts`** — mock `execFile` via `vi.mock("node:child_process")`:
- `getPrMetadata` parses `gh pr view --json ...` output into `PrMetadata`; label and file arrays map correctly; missing `body` falls back to `""`
- `getPrDiff` returns raw stdout
- Both throw on non-zero exit

**`impact-prompts.test.ts`** — construct `impactAnalyzerSystemPrompt("o/r", "/tmp/artifacts", "<memory body>")`:
- contains all five required section headers: `## Summary`, `## Touched Zones`, `## Affected Symbols & Concepts`, `## Risks per Memory`, `## Memory Gaps`
- contains the `"IMPACT_ANALYSIS_DONE"` sentinel
- contains the read-only + no-repo-access constraint strings
- contains the embedded memory body verbatim
- calling with an empty memory body produces a prompt that contains the "NO MEMORY AVAILABLE" fallback
- does NOT contain any instruction to grep, open source files, or walk call sites
- `impactAnalyzerInitialPrompt("/tmp/artifacts")` references the correct absolute path

**`pr-review-prompts.test.ts`** — construct `prSessionPrompt({ mode: "review", repo: "o/r", branch: "main", prNumber: 42, artifactsDir: "/tmp/a" })`:
- contains the auto-fix rule string (search for `category=style`)
- contains `gh pr comment 42 --repo o/r`
- does NOT contain `gh pr review` anywhere
- contains both subagent template markers (`[FILE-GROUP SUBAGENT]` and `[HOLISTIC SUBAGENT]`)
- contains `pr-impact.md` reference in the workflow section
- contains the `group.focus` field reference (per-group focus is mandatory)
- contains the "Subagents do NOT receive the full memory block" line (context-hiding contract)

**Verify:** `npm test`

**Commit:** `test(pr-review): schemas, gh wrappers, impact prompts, and orchestrator prompt`

---

## Task 10: Manual verification

No commit for this task. Definition of Done requires manual run per AGENTS.md.

1. `npm run dev`
2. Ensure memory has been built for your test repo (first run on the repo will cold-build automatically; subsequent runs will noop if nothing changed).
3. Open a small, live PR on a registered repo where you have push access.
4. Telegram: `review <PR URL>`.
5. Watch dashboard + logs in order:
   - `memory` stage runs (cold on a fresh repo, warm/noop after).
   - `pr-review` pipeline writes `artifacts/<taskId>/{pr-context.json, pr.diff}`.
   - `pr_impact_analyzer` stage runs with cwd = artifactsDir. Confirm `artifacts/<taskId>/pr-impact.md` appears with all five section headers, zone names quoted from memory, and no [path:line] citations the agent couldn't have gotten from memory.
   - A PR session spawns. The sessionfile shows the orchestrator reading `pr-impact.md` first, then writing `review-plan.json` with a non-empty `focus` on every group.
   - Subagent tool calls appear. Confirm their prompts include the distilled focus string but NOT the full memory block.
   - `artifacts/<taskId>/reports/*.json` appears.
   - 1-3 commits land on the PR branch.
   - A single `gh pr comment` shows up with the structured summary.
6. Negative tests:
   - **Missing memory:** `rm -rf artifacts/memory-<INSTANCE>-<repo>/` before running. Confirm memory cold-builds, then the analyzer runs with the fresh memory (not the empty case — memory will have rebuilt by then). To actually hit the empty case, mock `memoryBlock` to return `""` once and confirm the analyzer produces a report where "Memory Gaps" lists every touched area.
   - **Failed analyzer:** SIGKILL the pi subprocess for the analyzer stage. Confirm the review orchestrator starts anyway, logs "proceeding without report", and every group falls back to a focus string that says "impact report missing".
7. Reply to the PR comment on GitHub. Verify the poller picks it up and `resumePrSession` runs (existing loop, no new code).
8. Close the PR or revert the commits before merging; this was a test run.

If any step regresses: stop, surface the log line verbatim, do not paper over with try/catch.

---

## Explicit non-goals for v1

- Inline review comments on specific lines (`gh pr review` with line-anchored comments). Punt until line-number drift is solved.
- Fork PRs / PRs where push is denied. Assumed same-repo.
- Dimensions beyond `correctness / style / tests / security`.
- Auto-fix of `major`/`blocker` correctness or any `security` issue. Always flagged.
- Giving the impact analyzer repo access. Locked to memory + diff for v1; if memory turns out to be too thin in practice we revisit (per #1 answer: "let's start with A and then we will change it").
- Full memory block inside subagent prompts. The orchestrator distills per-group focus; subagents stay lean.

---

Plan updated to reflect the landed memory system. Ready to execute, or want another pass?
