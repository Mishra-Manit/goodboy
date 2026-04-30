/**
 * Parse the trailing JSON marker the agent appends to every chat reply.
 * Pure: returns `null` for missing/malformed markers, never throws.
 */

import { z } from "zod";
import type { ReviewChatResult } from "./types.js";

const reviewChatResultSchema = z.object({
  status: z.enum(["complete", "failed"]),
  changed: z.boolean(),
});

/** Find the last balanced `{...}` block that validates as a result, or null. */
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

/** Walk the text and return every top-level balanced `{...}` block. String/escape aware. */
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
