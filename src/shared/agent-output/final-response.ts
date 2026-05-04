/**
 * Pure helpers for extracting and validating final assistant response JSON.
 * Stage agents use bare JSON; review chat uses prose plus a final-line marker.
 */

import { z } from "zod";
import type { FileEntry } from "../contracts/session.js";
import { reviewChatFinalResponseSchema, stageCompleteFinalResponseSchema } from "./contracts.js";

/** Return the latest non-empty assistant text from a pi session entry list. */
export function latestAssistantText(entries: readonly FileEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const text = entry.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return null;
}

/** Parse and validate text that must be exactly one JSON object. */
export function parseBareFinalJson<T>(text: string, schema: z.ZodType<T>): T | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Parse and validate only the final line as strict JSON. */
export function parseFinalLineJson<T>(text: string, schema: z.ZodType<T>): T | null {
  const lines = text.trimEnd().split("\n");
  const last = lines[lines.length - 1]?.trim();
  if (!last) return null;
  return parseBareFinalJson(last, schema);
}

/** Remove a valid review-chat marker from the final line, preserving reply prose. */
export function stripFinalLineJsonMarker(text: string): string {
  const lines = text.trimEnd().split("\n");
  if (parseFinalLineJson(text, reviewChatFinalResponseSchema)) return lines.slice(0, -1).join("\n").trimEnd();
  return text;
}

