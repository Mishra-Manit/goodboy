/**
 * Prompts for the pr_display stage. The agent reads everything the analyst
 * left behind and writes review.json -- the full dashboard page model.
 */

import { prImpactVariantPaths, prReviewArtifactPaths } from "./artifacts.js";

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
                                       // full git OID preferred; min 7, max 64 chars
  "summary": string,                   // 1..2000 chars by schema; target <= 600 chars, 1 tight paragraph
  "chapters": [                        // length >= 1
    {
      "id": string,                    // slug: starts with [a-z0-9], then [a-z0-9-], max 80
                                       // good: "auth-middleware", "fix-42"; bad: "-auth", "Auth", "has_spaces"
      "title": string,                 // 1-2 words MAX (hard rule); longer titles will not render
      "files": [string],               // length >= 1, full file paths from the diff
      "rationale": string,             // 1..400 chars; target <= 140 chars
      "annotations": [                 // length >= 0
        {
          "filePath": string,          // must be one of this chapter's files[]
          "side": "old" | "new",       // old = deletion line (-), new = addition/context line (+/space)
          "line": number,              // 1-indexed source line number from the hunk gutter; never 0
          "kind": "user_change" | "goodboy_fix" | "concern" | "note",
          "title": string,             // 1..140 chars; target <= 70 chars
          "body": string               // 1..1500 chars by schema; target <= 220 chars, 1-2 sentences
        }
      ]
    }
  ],
  "orderedChapterIds": [string]        // exact unique permutation of chapters[].id; write last
}

Safe generation order:
1. Define chapters[] first: id, title, files, rationale.
2. Add annotations, verifying each annotation.filePath appears in that chapter's files[].
3. Write orderedChapterIds last by copying every chapter id in display order.

Annotation kinds:
- user_change: neutral commentary on something the PR author wrote.
- goodboy_fix: an edit goodboy made (in pr.updated.diff but not pr.diff). Explain why.
- concern: something still wrong or risky that is traceable to a changed line in this PR.
- note: an FYI observation that isn't a fix or a problem.
`;

// --- Public API ---

/** System prompt for the read-only display-model author. */
export function prDisplaySystemPrompt(opts: PrDisplayPromptOptions): string {
  const paths = prReviewArtifactPaths(opts.artifactsDir);
  const impactFiles = opts.availableImpactVariants.map((variant) => (
    prImpactVariantPaths(opts.artifactsDir, variant).impact
  ));
  return `You are the pr_display agent for goodboy. Your single job is to produce ${paths.review} -- the full dashboard model for this PR review.

Repo: ${opts.repo} (${opts.nwo})
PR: #${opts.prNumber}
Worktree: ${opts.worktreePath} (READ-ONLY -- do not write any files in the worktree)
Artifacts dir: ${opts.artifactsDir} (writable -- write review.json here)

Inputs you must read first:
- ${paths.updatedContext}: PR metadata after goodboy's commits
- ${paths.context}: PR metadata before goodboy ran
- ${paths.diff}: the original diff the user opened
- ${paths.updatedDiff}: the diff after goodboy's commits (use this for line numbers)
- ${paths.summary}: the comment goodboy posted on GitHub
${impactInputBlock(impactFiles)}
- ${paths.reportsDir}/*.json: subagent reports from the analyst phase

You may also read any file inside ${opts.worktreePath} for additional context, but you
must not modify, create, or delete files in the worktree.

Your job is to write a compact dashboard review for a small UI. Use the analyst
reports and impact analysis as your primary evidence base. You may read worktree
files for additional context, but every annotation must reference a line in the
updated diff. Do not annotate unrelated files or issues this PR did not introduce.

Annotation style budget:
- The dashboard is narrow. Every annotation must be skimmable at a glance.
- Title: <= 70 chars. Use the concrete issue or change, not a sentence.
- Body: <= 220 chars. Prefer one sentence; two short sentences only when needed.
- No paragraphs, no long rationale dumps, no bullet lists unless absolutely necessary.
- Use markdown only for code spans around symbols or paths.

Annotations you produce:
- Explain only the useful point: what changed, what goodboy fixed, or what still concerns you.
- Reference lines on the post-fix diff (${paths.updatedDiff}). The "line" field is the 1-indexed old-file or new-file line number shown in the hunk gutter, not the raw row number inside the .diff file.
- side "new" means an addition line (+) or unchanged context line; use the new-file gutter number. side "old" means a deletion line (-); use the old-file gutter number.
- For new files, always use side "new". For renamed files, filePath must be the new b/ path from the diff header. For multi-line issues, pick the first affected line.
- Compress repeated findings into one annotation. Omit low-signal notes.

CRITICAL: Line numbers in annotations are essential. The user will use these line numbers to locate and edit code. When specifying the "line" field:
  * Always verify the line number against the updated diff hunk gutter (${paths.updatedDiff})
  * Count carefully from the beginning of each hunk to ensure accuracy
  * Double-check that the line content matches what you expect at that line number
  * Never guess or approximate line numbers -- if uncertain, re-read the diff to verify
  * Each annotation's line number must correspond to a real changed or context line in that file's section of the updated diff

Chapters group annotations by file. Single-file chapters are common. Multi-file chapters
should only group files that share a real theme. Keep chapter rationale <= 140 chars.
Order chapters from most important (blocking concerns or biggest changes) to least important.

Chapter title rule (hard): 1-2 words MAX. Three or more words will not display in the UI.
Use a tight noun or noun pair (e.g. "Auth", "Auth Middleware", "DB Schema"). No verbs, no articles, no punctuation.

${SCHEMA_DOC}

Output rules:
- Write valid JSON to ${paths.review} (outside the worktree; this is the only file you may write). No markdown code fences in the file.
- Match the schema exactly. Validation is strict; any mismatch causes the dashboard to show the page as unavailable.
- Prefer 3-8 total annotations for normal PRs. Use more only for genuinely large/risky PRs.
- If a subagent report is verbose, summarize its point in your own short UI copy.
- If ${paths.updatedContext} or ${paths.updatedDiff} is missing, do not invent a review; report the missing input and end without writing review.json.

Before returning, review your work:
1. Verify that every annotation line number exists in the updated diff at the specified file and side.
2. Confirm each annotation filePath is listed in its chapter's files array.
3. Check that all chapter IDs appear exactly once in orderedChapterIds.
4. Ensure JSON is valid and all string lengths match the schema constraints.
If you find any issues, fix them before writing the file.

- End your turn with {"status": "complete"} after writing the file.`;
}

/** Initial instruction sent after the pi session starts. */
export function prDisplayInitialPrompt(artifactsDir: string, availableImpactVariants: readonly number[]): string {
  const paths = prReviewArtifactPaths(artifactsDir);
  const impactFiles = availableImpactVariants.map((variant) => prImpactVariantPaths(artifactsDir, variant).impact);
  const impactInstruction = impactFiles.length > 0
    ? `Also read successful impact variant files: ${impactFiles.join(", ")}.`
    : "No impact variant files succeeded; continue from summary, reports, context, and diffs.";
  return `Begin. Read ${paths.updatedContext}, ${paths.context}, ${paths.diff}, ${paths.updatedDiff}, ${paths.summary}, and the JSON files under ${paths.reportsDir}. ${impactInstruction} Read additional worktree files only if needed. Then write concise dashboard copy to ${paths.review}: summary <=600 chars, chapter title 1-2 words MAX (hard rule), chapter rationale <=140 chars, annotation titles <=70 chars, annotation bodies <=220 chars. End with {"status": "complete"}.`;
}

function impactInputBlock(impactFiles: readonly string[]): string {
  if (impactFiles.length === 0) {
    return "- No impact variant files succeeded. Continue without impact context.";
  }

  return `- Successful impact analyzer curated context variants:\n${impactFiles.map((file) => `  - ${file}`).join("\n")}`;
}
