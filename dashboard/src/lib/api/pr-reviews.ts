/** Open GitHub PR inbox + dashboard review trigger endpoints. */

import { request } from "./client.js";
import type { CreatePrReviewResponse, PrInboxResponse } from "./types.js";

/** Fetch live GitHub PRs merged with Goodboy review/session state. */
export async function fetchPrInbox(repo: string): Promise<PrInboxResponse> {
  return request(`/api/github/prs?repo=${encodeURIComponent(repo)}`);
}

/** Start a review task; `replaceExisting` closes the current review session before rerunning. */
export async function createPrReview(input: {
  repo: string;
  prNumber: number;
  replaceExisting?: boolean;
}): Promise<CreatePrReviewResponse> {
  return request("/api/pr-reviews", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
