/** PR review session endpoints (watchers + per-session runs). */

import { request } from "./client.js";
import type {
  PrSession,
  PrSessionWatchStatus,
  PrSessionWithRuns,
  FileEntry,
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

export async function setPrSessionWatchStatus(
  id: string,
  watchStatus: PrSessionWatchStatus,
): Promise<PrSession> {
  return request(`/api/pr-sessions/${id}/watch`, {
    method: "POST",
    body: JSON.stringify({ watchStatus }),
  });
}
