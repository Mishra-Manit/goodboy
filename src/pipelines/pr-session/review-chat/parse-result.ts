/** Parse the final-line JSON marker the agent appends to every chat reply. */

import { parseFinalLineJson } from "../../../shared/agent-output/final-response.js";
import { reviewChatFinalResponseSchema } from "../../../shared/agent-output/contracts.js";
import type { ReviewChatResult } from "./types.js";

/** Return the strict final-line result marker, or null when missing/malformed. */
export function parseReviewChatResult(text: string): ReviewChatResult | null {
  return parseFinalLineJson(text, reviewChatFinalResponseSchema);
}
