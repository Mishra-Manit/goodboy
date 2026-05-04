/** PR review session endpoints (watchers + per-session runs). */

import {
  prReviewPageDtoSchema,
  reviewChatPostResponseSchema,
  reviewChatResponseSchema,
} from "@dashboard/shared";
import type {
  ReviewChatRequest,
  ReviewChatResponse,
  ReviewChatPostResponse,
} from "@dashboard/shared";
import { request, requestJson } from "./client.js";
import type {
  PrSession,
  PrSessionWatchStatus,
  PrSessionWithRuns,
  FileEntry,
  PrReviewPageDto,
  PrSessionReconcileSummary,
} from "./types.js";

export async function fetchPrSessions(): Promise<PrSession[]> {
  return request("/api/pr-sessions");
}

/** Single session linked to a task that produced it (own coding or pr_review). */
export async function fetchPrSessionBySourceTask(taskId: string): Promise<PrSession | null> {
  const rows = await request<PrSession[]>(`/api/pr-sessions?sourceTaskId=${encodeURIComponent(taskId)}`);
  return rows[0] ?? null;
}

export async function fetchPrSessionDetail(id: string): Promise<PrSessionWithRuns> {
  return request(`/api/pr-sessions/${id}`);
}

export async function fetchPrSessionTranscript(id: string): Promise<{ entries: FileEntry[] }> {
  return request(`/api/pr-sessions/${id}/session`);
}

export async function fetchPrReviewPage(id: string): Promise<PrReviewPageDto> {
  return requestJson(`/api/pr-sessions/${id}/review`, prReviewPageDtoSchema);
}

export async function fetchReviewChat(id: string): Promise<ReviewChatResponse> {
  return requestJson(`/api/pr-sessions/${id}/review-chat`, reviewChatResponseSchema);
}

export async function sendReviewChatMessage(
  id: string,
  body: ReviewChatRequest,
): Promise<ReviewChatPostResponse> {
  return requestJson(`/api/pr-sessions/${id}/review-chat`, reviewChatPostResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function setPrSessionWatchStatus(
  id: string,
  watchStatus: PrSessionWatchStatus,
): Promise<PrSession> {
  return request(`/api/pr-sessions/${id}/watch`, {
    method: "POST",
    body: JSON.stringify({ watchStatus }),
  });
}

export async function reconcilePrSessions(apply: boolean): Promise<PrSessionReconcileSummary> {
  return request(`/api/pr-sessions/reconcile${apply ? "?apply=1" : ""}`, { method: "POST" });
}
