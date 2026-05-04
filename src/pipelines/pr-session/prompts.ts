/**
 * System prompts for the PR session. Supports two modes: `own` (we authored
 * the PR; address feedback on it) and `review` (external PR we are reviewing).
 */

import { prCreationFinalResponseContract } from "../../shared/agent-output/contracts.js";
import { finalResponsePromptBlock } from "../../shared/agent-output/prompts.js";
import { SHARED_RULES } from "../../shared/prompts/agent-prompts.js";
import type { PrComment } from "../../shared/domain/types.js";

export function prSessionPrompt(options: {
  mode: "own" | "review";
  repo: string;
  branch: string;
  githubRepo?: string;
  prNumber?: number;
  planPath?: string;
  summaryPath?: string;
  reviewPath?: string;
  feedbackToolPolicy?: string;
}): string {
  const { mode, repo, branch, githubRepo, prNumber, planPath, summaryPath, reviewPath, feedbackToolPolicy } = options;
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
    const artifactLines = [
      planPath ? `- Plan: ${planPath}` : null,
      summaryPath ? `- Implementation summary: ${summaryPath}` : null,
      reviewPath ? `- Review: ${reviewPath}` : null,
    ].filter(Boolean).join("\n");

    return `${shared}
MODE: You wrote the code for this PR.

${prNumber ? "" : `NO PR EXISTS YET. Your first job is to:
1. Push the branch: git push -u origin ${branch}
2. Read the artifact files for context on the PR description.
3. Create the PR: gh pr create --title "..." --body-file /path/to/body.md --base main --repo ${ghRepo}
4. Copy the exact PR URL printed by gh into your final response as prUrl.

CRITICAL: When writing the PR body, avoid using backticks for code formatting in the --body string passed to bash. Bash interprets backticks as command substitution, which will cause errors. Prefer writing the body to a file and using --body-file.
`}
${artifactLines ? `ARTIFACT FILES (read these for context):\n${artifactLines}` : ""}

${finalResponsePromptBlock(prNumber ? undefined : prCreationFinalResponseContract)}`;
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

/** Initial prompt for the PR creation turn (push branch + open PR). */
export const prCreationPrompt = `Push the branch and create a PR. Read the artifact files for context on the PR description.`;
