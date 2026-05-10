/**
 * Prompts for the pr_finalizer stage. The agent turns analyst raw material into
 * the public GitHub comment, optional visual snapshot, and dashboard review JSON.
 */

import { finalResponsePromptBlock, outputContractPromptBlock } from "../../../shared/agent-output/prompts.js";
import { prImpactVariantPaths, prReviewOutputs, prReviewReportsDir } from "../output-contracts.js";
import { PR_VISUAL_MANIFEST_FILENAME, PR_VISUAL_SUMMARY_FILENAME } from "../assets.js";

export interface PrFinalizerPromptOptions {
  taskId: string;
  repo: string;
  nwo: string;
  prNumber: number;
  artifactsDir: string;
  worktreePath: string;
  assetsDir: string;
  visualUrl: string;
  availableImpactVariants: readonly number[];
}

const FRONTEND_FILE_RE = String.raw`(^|/)(dashboard|app|pages|components|src)/|\.(tsx|jsx|css|scss|vue|svelte)$|tailwind|vite|next\.config`;

const SCHEMA_DOC = `
review.json schema:

{
  "prTitle": string,
  "headSha": string,
  "summary": string,
  "visualSnapshot":
    { "type": "skipped", "reason": "no_frontend_changes" }
    | { "type": "failed", "reason": string }
    | { "type": "captured", "assets": [{ "type": "image", "url": string, "label": string }] },
  "chapters": [
    {
      "id": string,
      "title": string,
      "narrative": string,
      "files": [{ "path": string, "narrative": string }],
      "annotations": [
        { "filePath": string, "line": number, "kind": "goodboy_fix" | "concern" | "note", "title": string, "body": string }
      ]
    }
  ]
}

Minimal valid shape to copy before filling details:
{
  "prTitle": "PR title from pr-context.updated.json",
  "headSha": "full headSha from pr-context.updated.json",
  "summary": "One tight paragraph for the dashboard.",
  "visualSnapshot": { "type": "skipped", "reason": "no_frontend_changes" },
  "chapters": [
    {
      "id": "chapter",
      "title": "Chapter",
      "narrative": "What this group of changes achieves.",
      "files": [{ "path": "src/example.ts", "narrative": "What changed in this file and why it matters." }],
      "annotations": []
    }
  ]
}

Report issue conversion:
- report issue 'file' becomes annotation 'filePath'
- report issue 'line_start' becomes annotation 'line'
- report issue 'category' and 'severity' are ranking inputs only
- unresolved report issues use kind "concern"
- every annotation filePath appears in that chapter's files[].path

Allowed dashboard enum values to copy exactly: "goodboy_fix", "concern", "note".
Chapter construction from selected annotations: files[].path must include every annotation filePath.
`;

// --- Public API ---

/** System prompt for the final public PR review presenter. */
export function prFinalizerSystemPrompt(opts: PrFinalizerPromptOptions): string {
  const paths = prFinalizerPaths(opts.artifactsDir);
  const outputs = [
    prReviewOutputs.review.resolve(opts.artifactsDir, undefined),
    prReviewOutputs.finalComment.resolve(opts.artifactsDir, undefined),
  ];
  const impactFiles = opts.availableImpactVariants.map((variant) => (
    prImpactVariantPaths(opts.artifactsDir, variant).impact
  ));
  return `You are the pr_finalizer agent for goodboy. Your job is to produce the final user-facing PR review presentation.

Repo: ${opts.repo} (${opts.nwo})
PR: #${opts.prNumber}
Task id: ${opts.taskId}
Worktree: ${opts.worktreePath} (final PR branch after Goodboy fixes)
Artifacts dir: ${opts.artifactsDir}
Assets dir: ${opts.assetsDir}
Visual summary filename: ${PR_VISUAL_SUMMARY_FILENAME}
Visual manifest filename: ${PR_VISUAL_MANIFEST_FILENAME}
Visual summary public URL: ${opts.visualUrl}
Final comment path: ${paths.finalComment}

ROBUST EXECUTION CONTRACT:
- Use real tool calls only. Never emit XML, markdown, or pseudo-tool syntax.
- Write ${paths.review} as one strict JSON object. Do not append status text.
- Write ${paths.finalComment} as the exact markdown posted to GitHub.
- GitHub comment create/update failure is fatal.
- Screenshot capture failure is not fatal; continue text-only and record visualSnapshot.type="failed".

${outputContractPromptBlock(outputs)}

${finalResponsePromptBlock()}

Inputs you must read first:
- ${paths.updatedContext}: PR metadata after goodboy's commits
- ${paths.updatedDiff}: final diff after goodboy's commits; use this for line numbers and frontend detection
- ${paths.summary}: analyst raw review material, not public copy
${impactInputBlock(impactFiles)}
- ${paths.reportsDir}/*.json: subagent reports from the analyst phase
- ${paths.context} and ${paths.diff} only if needed to explain goodboy_fix annotations

Responsibilities:
1. Read summary.md, reports, updated context, and updated diff.
2. Decide if the updated diff contains frontend changes. Frontend heuristic: changed paths matching /${FRONTEND_FILE_RE}/.
3. If no frontend changes, set visualSnapshot to {"type":"skipped","reason":"no_frontend_changes"} and do not spawn a recorder.
4. If frontend changes, spawn project-scoped pr-visual-recorder exactly once with a compact task containing: task_id=${opts.taskId}; artifacts_dir=${opts.artifactsDir}; assets_dir=${opts.assetsDir}; worktree_path=${opts.worktreePath}; updated_diff_path=${paths.updatedDiff}; public_asset_url=${opts.visualUrl}.
5. If recorder returns captured, set visualSnapshot to {"type":"captured","assets":[{"type":"image","url":"${opts.visualUrl}","label":"Visual snapshot"}]}.
6. If recorder fails or errors, set visualSnapshot to {"type":"failed","reason":"<specific reason>"}; continue without image markdown.
7. Write ${paths.finalComment} as the exact public GitHub comment. It MUST include <!-- goodboy:pr-review task=${opts.taskId} -->.
8. Upsert the PR comment using gh. If a comment with this task marker exists, update it. Otherwise create it.
9. Write ${paths.review} with clean dashboard summary, visualSnapshot, chapters, and annotations.
10. End with exactly {"status":"complete"}.

To upsert the GitHub comment:
1. Read ${paths.finalComment} into body.
2. Run gh pr view ${opts.prNumber} --repo ${opts.nwo} --json comments.
3. Find an existing comment whose body contains "goodboy:pr-review task=${opts.taskId}".
4. If found, PATCH it with gh api repos/${opts.nwo}/issues/comments/<id> -X PATCH using the exact file contents as body.
5. If not found, run gh pr comment ${opts.prNumber} --repo ${opts.nwo} --body-file ${paths.finalComment}.

Public comment rules:
- Do not invent findings.
- Never omit blockers/majors from the public comment.
- You may merge or omit low-signal nits/follow-ups.
- Include the image markdown only when visualSnapshot is captured: ![Visual snapshot](${opts.visualUrl}).
- Do not include screenshot failure/skipped infrastructure warnings in final-comment.md.
- ${paths.finalComment} must contain exactly what was posted, including the marker and image markdown if captured.

Dashboard rules:
- review.json.summary is clean polished copy with no marker and no image markdown.
- review.json must include visualSnapshot whether skipped, failed, or captured.
- Annotation kind values must be exactly "goodboy_fix", "concern", or "note".
- Every annotation must reference a changed/context line in ${paths.updatedDiff}.
- Do not annotate unrelated files or issues this PR did not introduce.
- The top-level keys must be exactly prTitle, headSha, summary, visualSnapshot, chapters.
- Every chapter object must include id, title, narrative, files, annotations.
- Every file object must include path and narrative.
- Every annotation object must include filePath, line, kind, title, body.
- Chapter title rule: 1-2 words MAX.
- Prefer 3-8 high-impact annotations. Omit generic style nits and duplicates.

${SCHEMA_DOC}

Before returning:
1. Confirm ${paths.finalComment} is non-empty and includes the marker.
2. Confirm the GitHub comment was created or updated.
3. Confirm ${paths.review} is valid JSON matching the schema.
4. Confirm every annotation filePath is listed in its chapter files array.
5. Final response only: {"status":"complete"}.`;
}

/** Initial instruction sent after the pi session starts. */
export function prFinalizerInitialPrompt(artifactsDir: string, availableImpactVariants: readonly number[]): string {
  const paths = prFinalizerPaths(artifactsDir);
  const impactFiles = availableImpactVariants.map((variant) => prImpactVariantPaths(artifactsDir, variant).impact);
  const impactInstruction = impactFiles.length > 0
    ? `Also read successful impact variant files: ${impactFiles.join(", ")}.`
    : "No impact variant files succeeded; continue from summary, reports, context, and diffs.";
  return `Begin. Read ${paths.updatedContext}, ${paths.updatedDiff}, ${paths.summary}, and JSON files under ${paths.reportsDir}. ${impactInstruction} Decide whether frontend changes need pr-visual-recorder. Write exact posted markdown to ${paths.finalComment}, upsert the GitHub PR comment by task marker, then write review.json with Required top-level keys: prTitle, headSha, summary, visualSnapshot, chapters. Required chapter keys: id, title, narrative, files, annotations. Required file keys: path, narrative. Required annotation keys: filePath, line, kind, title, body. Convert report file→filePath and line_start→line. Use kind exactly "concern" for unresolved report issues. Report categories like correctness/tests/security/style are ranking inputs only. Final response only: {"status":"complete"}.`;
}

function impactInputBlock(impactFiles: readonly string[]): string {
  if (impactFiles.length === 0) {
    return "- No impact variant files succeeded. Continue without impact context.";
  }

  return `- Successful impact analyzer curated context variants:\n${impactFiles.map((file) => `  - ${file}`).join("\n")}`;
}

function prFinalizerPaths(artifactsDir: string) {
  return {
    context: prReviewOutputs.context.resolve(artifactsDir, undefined).path,
    diff: prReviewOutputs.diff.resolve(artifactsDir, undefined).path,
    updatedContext: prReviewOutputs.updatedContext.resolve(artifactsDir, undefined).path,
    updatedDiff: prReviewOutputs.updatedDiff.resolve(artifactsDir, undefined).path,
    summary: prReviewOutputs.summary.resolve(artifactsDir, undefined).path,
    finalComment: prReviewOutputs.finalComment.resolve(artifactsDir, undefined).path,
    review: prReviewOutputs.review.resolve(artifactsDir, undefined).path,
    reportsDir: prReviewReportsDir(artifactsDir),
  };
}
