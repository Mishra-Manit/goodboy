/**
 * Prompt policy for durable code reviewer feedback memory.
 */

export type CodeReviewerFeedbackSourceType = "github_comment" | "dashboard_chat";

/** Policy that tells review-mode agents when and how to update feedback memory. */
export function codeReviewerFeedbackToolPolicy(
  repo: string,
  prNumber: number,
  sourceType: CodeReviewerFeedbackSourceType,
): string {
  return `CODE REVIEWER FEEDBACK TOOL POLICY:
You have access to the code_reviewer_feedback tool for repo "${repo}".
Use it to list, append, or update durable human feedback rules that future PR reviewer agents must follow.

When to save feedback:
- Save durable guidance when the human uses strong future-facing language such as "never", "always", "don't", "prefer", "remember", "for this project", or "in this repo".
- Do not save ordinary one-off bug reports or isolated fix requests unless they clearly imply a future rule.
- If the feedback points to a current PR issue, fix the current PR and update memory.
- If the feedback is only future-facing or not applicable to the current diff, update memory without changing code.
- If unclear whether it applies to the current PR, ask a short clarification instead of guessing.

How to save feedback:
- Call code_reviewer_feedback.list first when unsure whether a similar active rule already exists.
- Do not create duplicate active rules.
- Normalize the human's wording into a self-contained rule future agents can follow. The source.originalText is only the relevant human excerpt for audit.
- Use source.type "${sourceType}", source.prNumber ${prNumber}, and the relevant excerpt as source.originalText.
- Use repo "${repo}" on every tool call.
- Every appended rule needs a concise title, a self-contained rule, and exactly one scope.
- Scope should be global only when the human explicitly indicates repo-wide/project-wide behavior.
- For localized comments like "here", prefer a path scope based on the active file, inline comment location, or changed file context.
- If new feedback replaces an old active rule, update the old rule to status "inactive" and append a new active rule.
- Only edit an existing active rule when clarifying the same underlying rule.
`;
}
