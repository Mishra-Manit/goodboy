/**
 * Review-chat prompt construction and result parsing for dashboard-driven
 * conversations on `pr_review` sessions. Pure functions only -- IO lives in
 * `session.ts`. Exports are kept small so unit tests can lock the contract.
 */

import { z } from "zod";
import type { PrReviewAnnotation } from "../../shared/pr-review.js";

// --- Types ---

export interface ReviewChatContext {
  message: string;
  activeFile: string | null;
  annotation: PrReviewAnnotation | null;
}

export interface ReviewChatArtifacts {
  reviewPath: string;
  summaryPath: string;
  diffPath: string;
  updatedDiffPath: string;
  contextPath: string;
  updatedContextPath: string;
  reportsDir: string;
}

export interface ReviewChatResult {
  status: "complete" | "failed";
  reply: string;
  changed: boolean;
}

const reviewChatResultSchema = z.object({
  status: z.enum(["complete", "failed"]),
  reply: z.string().min(1).max(400),
  changed: z.boolean(),
});

// --- Prompts ---

/** Static system prompt: rules the agent must obey for every chat turn. */
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

/** Per-turn user prompt: rendered context + artifact paths + the user's message. */
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
    annotationBlock ? `\nREPLYING TO ANNOTATION:\n${annotationBlock}` : "",
    "",
    "USER MESSAGE:",
    context.message,
    "",
    "Respond, and end with the JSON marker.",
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

// --- Parsing ---

/**
 * Parse the trailing JSON marker from assistant text. Returns the last valid
 * marker found, or `null` when missing/malformed. Never throws -- the caller
 * decides how to handle a missing marker.
 */
export function parseReviewChatResult(text: string): ReviewChatResult | null {
  const candidates = extractJsonObjects(text);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const parsed = safeJsonParse(candidates[i]);
    if (!parsed) continue;
    const validated = reviewChatResultSchema.safeParse(parsed);
    if (validated.success) return validated.data;
  }
  return null;
}

/** Walk the string, pull out balanced top-level `{...}` blocks. Strings/escapes aware. */
function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
