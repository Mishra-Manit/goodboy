/** PR review session endpoints (watchers + per-session runs). */

import { request } from "./client.js";
import type { PrSession, PrSessionWithRuns, FileEntry } from "./types.js";

export async function fetchPrSessions(): Promise<PrSession[]> {
  return request("/api/pr-sessions");
}

export async function fetchPrSessionDetail(id: string): Promise<PrSessionWithRuns> {
  return request(`/api/pr-sessions/${id}`);
}

export async function fetchPrSessionTranscript(id: string): Promise<{ entries: FileEntry[] }> {
  return request(`/api/pr-sessions/${id}/session`);
}
