/**
 * System prompts for the PR session. Supports two modes: `own` (we authored
 * the PR; address feedback on it) and `review` (external PR we are reviewing).
 */

import { SHARED_RULES } from "../../shared/agent-prompts.js";

export function prSessionPrompt(options: {
  mode: "own" | "review";
  repo: string;
  branch: string;
  prNumber?: number;
  planPath?: string;
  summaryPath?: string;
  reviewPath?: string;
}): string {
  const { mode, repo, branch, prNumber, planPath, summaryPath, reviewPath } = options;

  const shared = `You are a PR session agent managing a pull request on GitHub.
${SHARED_RULES}
REPO: ${repo}
BRANCH: ${branch}
${prNumber ? `PR: #${prNumber}` : ""}

RULES:
- You can read/edit code, make commits, push, and interact via the gh CLI.
- When given feedback, make targeted fixes -- do not rewrite unrelated code.
- After making changes: commit with a conventional commit message, then push.
- Always push to the current branch. Never force-push unless explicitly asked.
- Use \`gh\` for all GitHub interactions (PR creation, reviews, comments).
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
3. Create the PR: gh pr create --title "..." --body "..." --base main --repo ${repo}
`}
${artifactLines ? `ARTIFACT FILES (read these for context):\n${artifactLines}` : ""}

When you are done, end your output with:
  {"status": "complete"}`;
  }

  // mode === "review"
  return `${shared}
MODE: You are reviewing PR #${prNumber} on ${repo}.

YOUR JOB:
1. Read the diff: gh pr diff ${prNumber} --repo ${repo}
2. Understand the changes thoroughly.
3. If you spot issues, fix them yourself -- edit the code, commit, and push.
4. Post your review via: gh pr review ${prNumber} --repo ${repo} --approve --body "..."
   Or if changes are needed that you cannot fix: gh pr review ${prNumber} --repo ${repo} --request-changes --body "..."

When you are done, end your output with:
  {"status": "complete"}`;
}

export function formatCommentsPrompt(
  comments: Array<{ author: string; body: string; path?: string; line?: number }>,
): string {
  const formatted = comments.map((c) => {
    const location = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : "";
    return `@${c.author}${location}:\n${c.body}`;
  }).join("\n\n---\n\n");

  return `New comments on your PR:\n\n${formatted}\n\nAddress the feedback, commit, and push. When done, end with: {"status": "complete"}`;
}

/** Initial prompt for the PR creation turn (push branch + open PR). */
export function prCreationPrompt(branch: string, artifactsDir: string): string {
  return `Push the branch and create a PR. Read the artifact files for context on the PR description.`;
}

/** Initial prompt for an external PR review turn. */
export function externalReviewPrompt(): string {
  return `Review this PR. Read the diff, understand the changes, and post your review.`;
}
