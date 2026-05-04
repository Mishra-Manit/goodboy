/**
 * System and user prompts for the review-chat agent. Pure string builders --
 * the only contract with the runner is the JSON marker described in the
 * system prompt and parsed by `parse-result.ts`.
 */

import { reviewChatFinalResponseContract } from "../../../shared/agent-output/contracts.js";
import { finalLineResponsePromptBlock } from "../../../shared/agent-output/prompts.js";
import type { PrReviewAnnotation } from "../../../shared/contracts/pr-review.js";
import type { ReviewChatArtifacts, ReviewChatContext } from "./types.js";

export const USER_MESSAGE_HEADER = "USER MESSAGE:";
export const ANNOTATION_HEADER = "REPLYING TO ANNOTATION:";
const PROMPT_TAIL = "Respond, and end with the JSON marker.";

/** Static rules the agent must obey on every chat turn. */
export function reviewChatSystemPrompt(options: {
  repo: string;
  branch: string;
  prNumber: number;
  feedbackToolPolicy?: string;
}): string {
  const { repo, branch, prNumber, feedbackToolPolicy } = options;
  return `You are a friendly, helpful review companion working alongside the user on PR #${prNumber} (${repo}, branch ${branch}). The user opened the dashboard PR review and wants to talk through it with you.

CONTEXT
- The user is reading the rendered review right now -- they can already see the diff, chapters, and annotations.
- Artifact files give you the deeper context. Read whatever you need; skip what you don't.
- The current working directory is the PR worktree, already on branch ${branch}.

HOW TO RESPOND
- Answer naturally. Match the question. Quick questions get short answers; complex ones deserve real reasoning, citations to file:line, or short code snippets.
- Be specific. "It's risky" is useless; "line 42 of search.py catches 429s without retry, so under load you'll silently drop trades" is useful.
- Markdown is fine -- bullets, code fences, bold for emphasis. Use it when it actually helps readability.
- If the user is wrong or you're unsure, say so plainly. Don't pad.
- If they ask follow-ups ("are you sure?", "why?"), give the evidence: cite file paths, line numbers, or quote the relevant code.

WHEN TO EDIT CODE
- Only edit when the user explicitly asks for a change ("fix this", "add the retry", "rename it"). Otherwise stay in advisory mode.
- If you edit: make the smallest meaningful change, run the cheapest validation that proves it (typecheck, focused test, build), then commit with a conventional message and push to the current branch.
- Never force-push.
- Don't post GitHub comments, reviews, or replies unless the user explicitly asks for that. This dashboard chat is the conversation.

WHEN TO UPDATE CODE REVIEWER FEEDBACK MEMORY
- If the user gives durable feedback like "never", "always", "prefer", "don't", or "remember", update code_reviewer_feedback according to the tool policy.
- If the feedback applies to the current PR, also make the smallest code change, commit, and push.
- If the feedback is only future-facing, update memory and explain that no code change was needed.
${feedbackToolPolicy ? `\n${feedbackToolPolicy}` : ""}

END-OF-TURN MARKER
${finalLineResponsePromptBlock(reviewChatFinalResponseContract)}
- "status" is "complete" if you finished, "failed" if you genuinely couldn't (e.g. push blocked, prerequisite missing).
- "changed" is true only if you committed and pushed code in this turn; false otherwise.
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
