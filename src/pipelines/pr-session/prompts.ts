/**
 * System prompts for the PR session. Supports two modes: `own` (we authored
 * the PR; address feedback on it) and `review` (external PR we are reviewing).
 * PR creation is handled exclusively by the pr_creator pipeline stage
 * in `coding/prompts.ts` and never by this module.
 */

import { finalResponsePromptBlock } from "../../shared/agent-output/prompts.js";
import { SHARED_RULES } from "../../shared/prompts/agent-prompts.js";
import type { PrComment } from "../../shared/domain/types.js";

export function prSessionPrompt(options: {
  mode: "own" | "review";
  repo: string;
  branch: string;
  githubRepo?: string;
  prNumber?: number;
  feedbackToolPolicy?: string;
}): string {
  const { mode, repo, branch, githubRepo, prNumber, feedbackToolPolicy } = options;
  const ghRepo = githubRepo ?? repo;

  const shared = `You are a PR session agent managing a pull request on GitHub.
${SHARED_RULES}
REPO: ${repo}
GITHUB_REPO: ${ghRepo}
BRANCH: ${branch}
${prNumber ? `PR: #${prNumber}` : ""}

RULES:
- You can read/edit code, make commits, push, and interact via the gh CLI.
- When given feedback, make targeted fixes -- do not rewrite unrelated code.
- After making changes: commit with a conventional commit message, then push.
- Always push to the current branch. Never force-push unless explicitly asked.
- Use \`gh\` for all GitHub interactions (PR creation, reviews, comments).
${feedbackToolPolicy ? `\n${feedbackToolPolicy}` : ""}
`;

  if (mode === "own") {
    return `${shared}
MODE: You wrote the code for this PR and are now addressing reviewer feedback.
Address feedback directly: edit code, commit, and push changes to the branch.

${finalResponsePromptBlock()}`;
  }

  // mode === "review"
  return `${shared}
MODE: You are reviewing PR #${prNumber} on ${repo}.

YOUR JOB:
1. Read the diff: gh pr diff ${prNumber} --repo ${ghRepo}
2. Understand the changes thoroughly.
3. If you spot issues, fix them yourself -- edit the code, commit, and push.
4. Post your review via: gh pr review ${prNumber} --repo ${ghRepo} --approve --body "..."
   Or if changes are needed that you cannot fix: gh pr review ${prNumber} --repo ${ghRepo} --request-changes --body "..."

${finalResponsePromptBlock()}`;
}

/** Render the new-comments prompt. Each comment carries its own kind tag. */
export function formatCommentsPrompt(comments: PrComment[]): string {
  const formatted = comments.map(formatComment).join("\n\n---\n\n");
  return `New comments on your PR:\n\n${formatted}\n\nAddress the feedback, commit, and push. If a comment contains durable future-facing feedback, follow the code reviewer feedback tool policy in your system prompt. If a review is an approval with no actionable request, acknowledge politely and do nothing else.\n\n${finalResponsePromptBlock()}`;
}

function formatComment(c: PrComment): string {
  switch (c.kind) {
    case "conversation":
      return `[conversation comment] @${c.author}:\n${c.body}`;
    case "inline": {
      const loc = c.path ? `${c.path}${c.line !== null ? `:${c.line}` : ""}` : "";
      return `[inline comment] @${c.author}${loc ? ` (${loc})` : ""}:\n${c.body}`;
    }
    case "review_summary":
      return `[review submission -- ${c.state}] @${c.author}:\n${c.body}`;
  }
}
