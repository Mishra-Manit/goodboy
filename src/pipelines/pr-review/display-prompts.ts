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
  "summary": string,                   // 1..2000 chars, 1-2 paragraph editorial intro
  "chapters": [                        // length >= 1
    {
      "id": string,                    // slug: starts with [a-z0-9], then [a-z0-9-], max 80
                                       // good: "auth-middleware", "fix-42"; bad: "-auth", "Auth", "has_spaces"
      "title": string,                 // 1..120 chars
      "files": [string],               // length >= 1, full file paths from the diff
      "rationale": string,             // 1..400 chars, why this chapter exists
      "annotations": [                 // length >= 0
        {
          "filePath": string,          // must be one of this chapter's files[]
          "side": "old" | "new",       // old = deletion line (-), new = addition/context line (+/space)
          "line": number,              // 1-indexed source line number from the hunk gutter; never 0
          "kind": "user_change" | "goodboy_fix" | "concern" | "note",
          "title": string,             // 1..140 chars
          "body": string               // 1..1500 chars, freeform markdown
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

Your job is to write a polished, editorial review of this PR. Use the analyst
reports and impact analysis as your primary evidence base. You may read worktree
files for additional context, but every annotation must reference a line in the
updated diff. Do not annotate unrelated files or issues this PR did not introduce.

Annotations you produce:
- Should explain what the user changed, what goodboy fixed, and what still concerns you.
- Reference lines on the post-fix diff (${paths.updatedDiff}). The "line" field is the 1-indexed old-file or new-file line number shown in the hunk gutter, not the raw row number inside the .diff file.
- side "new" means an addition line (+) or unchanged context line; use the new-file gutter number. side "old" means a deletion line (-); use the old-file gutter number.
- For new files, always use side "new". For renamed files, filePath must be the new b/ path from the diff header. For multi-line issues, pick the first affected line.
- Be concise. 1-3 sentence bodies are normal. Long bodies only when complexity demands.
- Use markdown sparingly: code spans, short bullet lists if needed.

Chapters group annotations by file. Single-file chapters are common. Multi-file chapters
should only group files that share a real theme. Order chapters from most important
(blocking concerns or biggest changes) to least important.

${SCHEMA_DOC}

Output rules:
- Write valid JSON to ${paths.review} (outside the worktree; this is the only file you may write). No markdown code fences in the file.
- Match the schema exactly. Validation is strict; any mismatch causes the dashboard to show the page as unavailable.
- If ${paths.updatedContext} or ${paths.updatedDiff} is missing, do not invent a review; report the missing input and end without writing review.json.
- End your turn with {"status": "complete"} after writing the file.`;
}

/** Initial instruction sent after the pi session starts. */
export function prDisplayInitialPrompt(artifactsDir: string, availableImpactVariants: readonly number[]): string {
  const paths = prReviewArtifactPaths(artifactsDir);
  const impactFiles = availableImpactVariants.map((variant) => prImpactVariantPaths(artifactsDir, variant).impact);
  const impactInstruction = impactFiles.length > 0
    ? `Also read successful impact variant files: ${impactFiles.join(", ")}.`
    : "No impact variant files succeeded; continue from summary, reports, context, and diffs.";
  return `Begin. Read ${paths.updatedContext}, ${paths.context}, ${paths.diff}, ${paths.updatedDiff}, ${paths.summary}, and the JSON files under ${paths.reportsDir}. ${impactInstruction} Read additional worktree files if you need deeper context. Then write the full review model to ${paths.review} matching the schema. End with {"status": "complete"}.`;
}

function impactInputBlock(impactFiles: readonly string[]): string {
  if (impactFiles.length === 0) {
    return "- No impact variant files succeeded. Continue without impact context.";
  }

  return `- Successful impact analyzer curated context variants:\n${impactFiles.map((file) => `  - ${file}`).join("\n")}`;
}
