/**
 * Prompts for the pr_display stage. The agent reads everything the analyst
 * left behind and writes review.json -- the full dashboard page model.
 */

import { finalResponsePromptBlock, outputContractPromptBlock } from "../../../shared/agent-output/prompts.js";
import { prImpactVariantPaths, prReviewOutputs, prReviewReportsDir } from "../output-contracts.js";

export interface PrDisplayPromptOptions {
  repo: string;
  nwo: string;
  prNumber: number;
  artifactsDir: string;
  worktreePath: string;
  availableImpactVariants: readonly number[];
}

const SCHEMA_DOC = `
review.json schema:

{
  "prTitle": string,                   // 1..200 chars
  "headSha": string,                   // copy "headSha" verbatim from pr-context.updated.json
  "summary": string,                   // 1..2000 chars; target <= 600 chars, 1 tight paragraph
  "chapters": [                        // length >= 1; array ORDER is display order
    {
      "id": string,                    // slug: starts with [a-z0-9], then [a-z0-9-], max 80
      "title": string,                 // 1-2 words MAX (hard rule)
      "narrative": string,             // 1..400 chars; what this group of changes achieves
      "files": [                       // length >= 1
        {
          "path": string,              // full file path from the diff
          "narrative": string          // 1..300 chars; what changed in this specific file, 2-3 sentences
        }
      ],
      "annotations": [                 // length >= 0
        {
          "filePath": string,          // must be one of this chapter's files[].path
          "line": number,              // 1-indexed source line number from the hunk gutter; never 0
          "kind": "goodboy_fix" | "concern" | "note",
          "title": string,             // 1..140 chars; target <= 70 chars
          "body": string               // 1..1500 chars; target <= 220 chars, 1-2 sentences
        }
      ]
    }
  ]
}

Minimal valid shape to copy before filling details:
{
  "prTitle": "PR title from pr-context.updated.json",
  "headSha": "full headSha from pr-context.updated.json",
  "summary": "One tight paragraph for the dashboard.",
  "chapters": [
    {
      "id": "post-mortem",
      "title": "Post-Mortem",
      "narrative": "What this group of changes achieves.",
      "files": [
        {
          "path": "backend/coliseum/agents/post_mortem/main.py",
          "narrative": "What changed in this file and why it matters. 2-3 sentences max."
        }
      ],
      "annotations": [
        {
          "filePath": "backend/coliseum/agents/post_mortem/main.py",
          "line": 137,
          "kind": "concern",
          "title": "Short concrete issue",
          "body": "One short sentence explaining impact and next action."
        }
      ]
    }
  ]
}

Report issue conversion:
When selecting an issue from a subagent report, convert it into a dashboard annotation like this:
- report issue 'file' becomes annotation 'filePath'
- report issue 'line_start' becomes annotation 'line'
- report issue 'category' and 'severity' are ranking inputs only; dashboard 'kind' comes from the allowed dashboard kind values below
- unresolved report issues use 'kind: "concern"'
- copy or rewrite report 'title' into annotation 'title'
- rewrite report 'rationale' + 'suggested_fix' into one short annotation 'body'

Allowed dashboard enum values to copy exactly:
- kind: "goodboy_fix", "concern", or "note"

Converted issue example:
{
  "filePath": "backend/coliseum/agents/post_mortem/main.py",
  "line": 164,
  "kind": "concern",
  "title": "Empty trade context reaches LLM",
  "body": "When all context loads fail, the model gets no trade data; return early before building the prompt."
}

Chapter construction from selected annotations:
- Set each chapter 'files' array to the unique annotation 'filePath' values in that chapter, expanded into objects with path and narrative.
- Every annotation 'filePath' must appear in the same chapter's 'files[].path' array.
- Prefer one chapter per file unless several files share one clear theme.
- Write a 'narrative' for each file (1..300 chars, 2-3 sentences) describing what changed in that specific file. This is distinct from the chapter 'narrative' which describes what the group achieves.

Safe generation order:
1. Start from the minimal valid shape above.
2. Fill prTitle and headSha from pr-context.updated.json.
3. Convert selected report issues into dashboard annotations using the conversion rules above.
4. Define chapters[] in display order: id, title, narrative, files, annotations.
5. Verify each annotation.filePath appears in that chapter's files[].path.

Annotation kinds:
- goodboy_fix: an edit goodboy made (in pr.updated.diff but not pr.diff). Explain why.
- concern: something still wrong or risky that is traceable to a changed line in this PR.
- note: an FYI observation that isn't a fix or a problem.

Dashboard enum rule:
Use only the kind values listed in this schema. Report categories such as correctness, tests, security, style, and report severities such as blocker, major, minor, nit are useful for ranking findings, but they are not dashboard kind values.
`;

// --- Public API ---

/** System prompt for the read-only display-model author. */
export function prDisplaySystemPrompt(opts: PrDisplayPromptOptions): string {
  const paths = prDisplayPaths(opts.artifactsDir);
  const output = prReviewOutputs.review.resolve(opts.artifactsDir, undefined);
  const impactFiles = opts.availableImpactVariants.map((variant) => (
    prImpactVariantPaths(opts.artifactsDir, variant).impact
  ));
  return `You are the pr_display agent for goodboy. Your single job is to produce ${paths.review} -- the full dashboard model for this PR review.

Repo: ${opts.repo} (${opts.nwo})
PR: #${opts.prNumber}
Worktree: ${opts.worktreePath} (READ-ONLY -- do not write any files in the worktree)
Artifacts dir: ${opts.artifactsDir} (writable -- write review.json here)

ROBUST EXECUTION CONTRACT:
- Use real tool calls only. Never emit XML, markdown, or pseudo-tool syntax such as <file_write>.
- Write exactly one JSON object to ${paths.review}; no markdown fences, no trailing prose, no second JSON object.
- Final status belongs only in your final assistant response. Never append {"status":"complete"} to review.json.

${outputContractPromptBlock([output])}

${finalResponsePromptBlock()}
- If required inputs are missing, do not fabricate a dashboard model.

Inputs you must read first:
- ${paths.updatedContext}: PR metadata after goodboy's commits
- ${paths.updatedDiff}: the diff after goodboy's commits (use this for line numbers)
- ${paths.summary}: the comment goodboy posted on GitHub
${impactInputBlock(impactFiles)}
- ${paths.reportsDir}/*.json: subagent reports from the analyst phase

Read ${paths.context} and ${paths.diff} only when you need to identify or explain
\`goodboy_fix\` annotations by comparing the original PR diff against the post-fix diff.

Avoid reading worktree files unless needed to resolve a conflict between reports
or verify a selected annotation whose line/content is unclear. The reports,
summary, impact files, and updated diff are the primary evidence base. The
worktree is read-only if you inspect it.

Your job is to write a compact, high-impact dashboard review for a small UI. Use
the analyst reports and impact analysis as your primary evidence base. Also,
every annotation must reference a line in the
updated diff. Do not annotate unrelated files or issues this PR did not introduce.

Annotation quality bar:
- Optimize for what helps the engineer decide or act during review.
- Prefer findings that are correctness, production safety, security, data integrity,
  migration, concurrency, API contract, or operational-risk issues.
- Each concern should explain the failure mode and the next action, not just name
  the smell. If no concrete action exists, downgrade or omit it.
- Omit generic style nits, speculative concerns, and duplicate findings.

Annotation style budget:
- The dashboard is narrow. Every annotation must be skimmable at a glance.
- Title: <= 70 chars. Use the concrete issue or change, not a sentence.
- Body: <= 220 chars. Prefer one sentence; two short sentences only when needed.
- No paragraphs, no long explanation dumps, no bullet lists unless absolutely necessary.
- Use markdown only for code spans around symbols or paths.

Selection workflow:
1. Select the final 3-8 annotations from reports, summary, and impact files.
2. Rank candidates by severity, evidence repeated across reports, runtime impact,
   and whether an engineer can take a clear next action.
3. Verify only the selected annotation lines against ${paths.updatedDiff}.
4. Write ${paths.review} without re-analyzing findings you did not select.

Annotations you produce:
- Explain only the useful point: what changed, what goodboy fixed, or what still concerns you.
- Reference lines on the post-fix diff (${paths.updatedDiff}). The "line" field is the 1-indexed source line number shown in the hunk gutter, not the raw row number inside the .diff file.
- Treat report-provided \`line_start\` / \`line_end\` values as primary anchors. Prefer them when they match the selected file.
- For renamed files, filePath must be the new b/ path from the diff header. For multi-line issues, pick the first affected line.
- Compress repeated findings into one annotation. Omit low-signal notes.

Line numbers matter, but verify efficiently:
  * For selected annotations, confirm the chosen line exists in ${paths.updatedDiff}
  * Prefer report-provided line numbers over re-deriving hunk offsets from scratch
  * If uncertain after one quick check, choose a nearby changed/context line from the same hunk
  * Do not manually recount unrelated hunks or verify findings you will not include

Tool and context budget:
- After reading required artifacts, make at most 4 additional read calls.
- Do not use bash except to list report filenames when needed.
- If enough evidence exists from reports and summary, write without extra reads.

Chapters group annotations by file. Single-file chapters are common. Multi-file chapters
should only group files that share a real theme. Keep chapter narrative <= 400 chars and each file narrative <= 300 chars.
Order chapters from most important (blocking concerns or biggest changes) to least important.

Chapter title rule (hard): 1-2 words MAX. Three or more words will not display in the UI.
Use a tight noun or noun pair (e.g. "Auth", "Auth Middleware", "DB Schema"). No verbs, no articles, no punctuation.

${SCHEMA_DOC}

Output rules:
- Write valid JSON to ${paths.review} (outside the worktree; this is the only file you may write). No markdown code fences, comments, status markers, or text outside the JSON object in the file.
- The top-level keys must be exactly the dashboard artifact keys from the schema: prTitle, headSha, summary, chapters.
- Every chapter object must include id, title, narrative, files, annotations.
- Every file object must include path and narrative.
- Every annotation object must include filePath, line, kind, title, body.
- Annotation kind values must be exactly "goodboy_fix", "concern", or "note"; use "concern" for unresolved report issues.
- Match the schema exactly. Validation is strict; any mismatch causes the dashboard to show the page as unavailable.
- Prefer 3-8 total annotations for normal PRs. Use more only for genuinely large/risky PRs.
- If a subagent report is verbose, summarize its point in your own short UI copy.
- If ${paths.updatedContext} or ${paths.updatedDiff} is missing, do not invent a review; report the missing input and end without writing review.json.

Before returning, review your work:
1. Verify selected annotation line numbers against the updated diff; do not verify discarded findings.
2. Confirm each annotation filePath is listed in its chapter's files array.
3. Confirm every file object has path and narrative, and every chapter has narrative.
4. Ensure JSON is valid and all string lengths match the schema constraints.
If you find any issues, fix them before writing the file.

- End your turn with the exact final-response JSON after writing and checking the file. This status is the final assistant response only, not part of review.json.`;
}

/** Initial instruction sent after the pi session starts. */
export function prDisplayInitialPrompt(artifactsDir: string, availableImpactVariants: readonly number[]): string {
  const paths = prDisplayPaths(artifactsDir);
  const impactFiles = availableImpactVariants.map((variant) => prImpactVariantPaths(artifactsDir, variant).impact);
  const impactInstruction = impactFiles.length > 0
    ? `Also read successful impact variant files: ${impactFiles.join(", ")}.`
    : "No impact variant files succeeded; continue from summary, reports, context, and diffs.";
  return `Begin. Read ${paths.updatedContext}, ${paths.updatedDiff}, ${paths.summary}, and the JSON files under ${paths.reportsDir}. ${impactInstruction} Read ${paths.context} and ${paths.diff} only if needed for goodboy_fix annotations. Avoid worktree reads unless selected annotation evidence is unclear. Select the final 3-8 high-impact annotations first, verify only those lines, then use the write tool to write exactly one dashboard artifact JSON object to ${paths.review}. Required top-level keys: prTitle, headSha, summary, chapters. Required chapter keys: id, title, narrative, files, annotations. Required file keys: path, narrative. Required annotation keys: filePath, line, kind, title, body. Convert report file→filePath and line_start→line. Use kind exactly "concern" for unresolved report issues; goodboy fixes use "goodboy_fix". Report categories like correctness/tests/security/style are ranking inputs only, not kind values. Keep summary <=600 chars, chapter title 1-2 words MAX (hard rule), chapter narrative <=400 chars, file narratives <=300 chars, annotation titles <=70 chars, annotation bodies <=220 chars. Do not append status text to review.json. Final response only: {"status":"complete"}.`;
}

function impactInputBlock(impactFiles: readonly string[]): string {
  if (impactFiles.length === 0) {
    return "- No impact variant files succeeded. Continue without impact context.";
  }

  return `- Successful impact analyzer curated context variants:\n${impactFiles.map((file) => `  - ${file}`).join("\n")}`;
}

function prDisplayPaths(artifactsDir: string) {
  return {
    context: prReviewOutputs.context.resolve(artifactsDir, undefined).path,
    diff: prReviewOutputs.diff.resolve(artifactsDir, undefined).path,
    updatedContext: prReviewOutputs.updatedContext.resolve(artifactsDir, undefined).path,
    updatedDiff: prReviewOutputs.updatedDiff.resolve(artifactsDir, undefined).path,
    summary: prReviewOutputs.summary.resolve(artifactsDir, undefined).path,
    review: prReviewOutputs.review.resolve(artifactsDir, undefined).path,
    reportsDir: prReviewReportsDir(artifactsDir),
  };
}
