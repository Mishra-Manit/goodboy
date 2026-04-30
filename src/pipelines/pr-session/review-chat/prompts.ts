/**
 * System and user prompts for the review-chat agent. Pure string builders --
 * the only contract with the runner is the JSON marker described in the
 * system prompt and parsed by `parse-result.ts`.
 */

import type { PrReviewAnnotation } from "../../../shared/pr-review.js";
import type { ReviewChatArtifacts, ReviewChatContext } from "./types.js";

export const USER_MESSAGE_HEADER = "USER MESSAGE:";
export const ANNOTATION_HEADER = "REPLYING TO ANNOTATION:";
const PROMPT_TAIL = "Respond, and end with the JSON marker.";

/** Static rules the agent must obey on every chat turn. */
export function reviewChatSystemPrompt(options: {
  repo: string;
  branch: string;
  prNumber: number;
}): string {
  const { repo, branch, prNumber } = options;
  return `You are review_chat, a dashboard agent helping the user discuss and refine PR #${prNumber} on ${repo} (branch ${branch}).

CONTEXT
- The user is reading the dashboard PR review for this PR.
- Artifact files give you the full review context. Read only what is needed.
- The current working directory is the PR worktree, already on branch ${branch}.

RULES
- The user may ask a question or request a targeted change. Decide which.
- Prefer changed files. Edit outside the diff only when directly required.
- If you edit code: make the smallest meaningful change, run the cheapest validation that proves it, then commit and push to the current branch.
- Never force-push.
- Do NOT post GitHub comments, reviews, or replies unless the user explicitly asks.
- Speak only inside this dashboard chat.

REPLY FORMAT
- Your final assistant message MUST end with exactly one JSON marker on its own line:
  {"status":"complete","reply":"<5-10 word texting-style summary>","changed":true|false}
- "reply" must be 5-10 words, no markdown, no quotes, plain prose.
- "changed" reflects whether you committed and pushed code in this turn.
- If you cannot complete the request, end with:
  {"status":"failed","reply":"<short reason in 5-10 words>","changed":<true|false>}
`;
}

/** Per-turn user prompt: artifact paths + active file + optional annotation + message. */
export function formatReviewChatPrompt(options: {
  context: ReviewChatContext;
  artifacts: ReviewChatArtifacts;
}): string {
  const { context, artifacts } = options;
  const annotationBlock = context.annotation ? formatAnnotation(context.annotation) : null;

  const lines = [
    "ARTIFACTS (read on demand):",
    `- review.json: ${artifacts.reviewPath}`,
    `- summary.md: ${artifacts.summaryPath}`,
    `- pr.diff: ${artifacts.diffPath}`,
    `- pr.updated.diff: ${artifacts.updatedDiffPath}`,
    `- pr-context.json: ${artifacts.contextPath}`,
    `- pr-context.updated.json: ${artifacts.updatedContextPath}`,
    `- reports/: ${artifacts.reportsDir}`,
    "",
    context.activeFile ? `ACTIVE FILE: ${context.activeFile}` : "ACTIVE FILE: (none)",
    annotationBlock ? `\n${ANNOTATION_HEADER}\n${annotationBlock}` : "",
    "",
    USER_MESSAGE_HEADER,
    context.message,
    "",
    PROMPT_TAIL,
  ];
  return lines.filter((line) => line !== "").join("\n");
}

function formatAnnotation(a: PrReviewAnnotation): string {
  const sideMark = a.side === "old" ? "-" : "+";
  return [
    `kind: ${a.kind}`,
    `location: ${a.filePath}:${sideMark}${a.line}`,
    `title: ${a.title}`,
    `body: ${a.body}`,
  ].join("\n");
}
