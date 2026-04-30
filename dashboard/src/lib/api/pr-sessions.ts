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
import { request } from "./client.js";
import type {
  PrSession,
  PrSessionWatchStatus,
  PrSessionWithRuns,
  FileEntry,
  PrReviewPageDto,
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
  const result = prReviewPageDtoSchema.safeParse(await request<unknown>(`/api/pr-sessions/${id}/review`));
  if (!result.success) throw new Error("Unexpected review response from server");
  return result.data;
}

export async function fetchReviewChat(id: string): Promise<ReviewChatResponse> {
  const result = reviewChatResponseSchema.safeParse(
    await request<unknown>(`/api/pr-sessions/${id}/review-chat`),
  );
  if (!result.success) throw new Error("Unexpected review chat response from server");
  return result.data;
}

export async function sendReviewChatMessage(
  id: string,
  body: ReviewChatRequest,
): Promise<ReviewChatPostResponse> {
  const result = reviewChatPostResponseSchema.safeParse(
    await request<unknown>(`/api/pr-sessions/${id}/review-chat`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  if (!result.success) throw new Error("Unexpected review chat reply from server");
  return result.data;
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
