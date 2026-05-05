/**
 * Recover review-chat user/assistant pairs from the PR-session JSONL. Pure.
 * User prompts are identified by the `USER MESSAGE:` block; assistant replies
 * must end with a valid final-line review-chat JSON marker.
 */

import {
  PR_REVIEW_ANNOTATION_KINDS,
  type PrReviewAnnotation,
  type ReviewChatMessage,
  type ReviewChatPart,
} from "../../../shared/contracts/pr-review.js";
import type { FileEntry } from "../../../shared/contracts/session.js";
import { stripFinalLineJsonMarker } from "../../../shared/agent-output/final-response.js";
import { ANNOTATION_HEADER, USER_MESSAGE_HEADER } from "./prompts.js";
import { parseReviewChatResult } from "./parse-result.js";

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
    if (!result || !assistantText) continue;

    const userParts: ReviewChatPart[] = [{ type: "text", text: userMessage.text }];
    if (userMessage.annotation) {
      userParts.push({ type: "annotation", annotation: userMessage.annotation });
    }

    messages.push({
      id: `${entry.id}-user`,
      role: "user",
      parts: userParts,
      createdAt: entry.timestamp,
    });
    messages.push({
      id: `${entry.id}-assistant`,
      role: "assistant",
      parts: [{ type: "text", text: stripResultMarker(assistantText) }],
      createdAt: entry.timestamp,
    });
  }
  return messages;
}

/** Remove the final-line result marker from assistant text. */
export function stripResultMarker(text: string): string {
  return stripFinalLineJsonMarker(text);
}

// --- Helpers ---

interface ParsedUserMessage {
  text: string;
  annotation: PrReviewAnnotation | null;
}

function parseUserMessage(text: string | null): ParsedUserMessage | null {
  if (!text) return null;
  const idx = text.indexOf(USER_MESSAGE_HEADER);
  if (idx === -1) return null;
  const after = text.slice(idx + USER_MESSAGE_HEADER.length).trim();
  const cleaned = after.replace(/\n+Respond, and end with the JSON marker\.?\s*$/i, "").trim();
  return { text: cleaned, annotation: parseAnnotationFromUserPrompt(text) };
}

function parseAnnotationFromUserPrompt(text: string): PrReviewAnnotation | null {
  const idx = text.indexOf(ANNOTATION_HEADER);
  if (idx === -1) return null;
  const block = text.slice(idx + ANNOTATION_HEADER.length).split(`\n\n${USER_MESSAGE_HEADER}`)[0];
  const fields = Object.fromEntries(
    block.split("\n")
      .map((line) => line.match(/^([a-z]+):\s*(.+)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => [m[1], m[2]] as const),
  );
  const location = fields.location?.match(/^(.+):(\d+)$/);
  if (!fields.kind || !fields.title || !fields.body || !location) return null;
  if (!isAnnotationKind(fields.kind)) return null;
  return {
    filePath: location[1],
    line: Number(location[2]),
    kind: fields.kind,
    title: fields.title,
    body: fields.body,
  };
}

function isAnnotationKind(value: string): value is PrReviewAnnotation["kind"] {
  return (PR_REVIEW_ANNOTATION_KINDS as readonly string[]).includes(value);
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
