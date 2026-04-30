/**
 * Review-chat prompt construction and result parsing for dashboard-driven
 * conversations on `pr_review` sessions. Pure functions only -- IO lives in
 * `session.ts`. Exports are kept small so unit tests can lock the contract.
 */

import { z } from "zod";
import type { PrReviewAnnotation, ReviewChatMessage, ReviewChatPart } from "../../shared/pr-review.js";
import type { FileEntry } from "../../shared/session.js";

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

// --- Transcript extraction ---

const USER_MESSAGE_HEADER = "USER MESSAGE:";
const ANNOTATION_HEADER = "REPLYING TO ANNOTATION:";

/**
 * Extract review_chat user/assistant pairs from a PR session transcript.
 * A user prompt is identified by the `USER MESSAGE:` block produced by
 * `formatReviewChatPrompt`; the next assistant message with a parseable
 * result marker is its reply. Other turns (poller comments, PR creation)
 * are skipped.
 */
export function extractReviewChatMessages(entries: FileEntry[]): ReviewChatMessage[] {
  const messages: ReviewChatMessage[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const userText = readMessageText(entry.message.content);
    const userMessage = parseUserMessage(userText);
    if (!userMessage) continue;

    const assistantText = findNextAssistantText(entries, i);
    const result = assistantText ? parseReviewChatResult(assistantText) : null;
    if (!result) continue;

    const userParts: ReviewChatPart[] = [{ type: "text", text: userMessage.text }];
    if (userMessage.annotation) userParts.push({ type: "annotation", annotation: userMessage.annotation });

    messages.push({
      id: `${entry.id}-user`,
      role: "user",
      parts: userParts,
      createdAt: entry.timestamp,
    });
    messages.push({
      id: `${entry.id}-assistant`,
      role: "assistant",
      parts: [{ type: "text", text: result.reply }],
      createdAt: entry.timestamp,
    });
  }
  return messages;
}

interface ParsedUserMessage {
  text: string;
  annotation: PrReviewAnnotation | null;
}

function parseUserMessage(text: string | null): ParsedUserMessage | null {
  if (!text) return null;
  const idx = text.indexOf(USER_MESSAGE_HEADER);
  if (idx === -1) return null;
  const after = text.slice(idx + USER_MESSAGE_HEADER.length).trim();
  // Drop trailing instruction tail produced by formatReviewChatPrompt.
  const cleaned = after.replace(/\n+Respond, and end with the JSON marker\.?\s*$/i, "").trim();
  return { text: cleaned, annotation: parseAnnotationFromUserPrompt(text) };
}

function parseAnnotationFromUserPrompt(text: string): PrReviewAnnotation | null {
  const idx = text.indexOf(ANNOTATION_HEADER);
  if (idx === -1) return null;
  const block = text.slice(idx + ANNOTATION_HEADER.length).split("\n\nUSER MESSAGE:")[0];
  const fields = Object.fromEntries(
    block.split("\n")
      .map((line) => line.match(/^([a-z]+):\s*(.+)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => [m[1], m[2]] as const),
  );
  const location = fields.location?.match(/^(.+):([+-])(\d+)$/);
  if (!fields.kind || !fields.title || !fields.body || !location) return null;
  return {
    filePath: location[1],
    side: location[2] === "-" ? "old" : "new",
    line: Number(location[3]),
    kind: fields.kind as PrReviewAnnotation["kind"],
    title: fields.title,
    body: fields.body,
  };
}

function readMessageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      texts.push((block as { text: string }).text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

function findNextAssistantText(entries: FileEntry[], fromIndex: number): string | null {
  for (let i = fromIndex + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") break;
    if (entry.message.role !== "assistant") continue;
    const text = readMessageText(entry.message.content);
    if (text) return text;
  }
  return null;
}
