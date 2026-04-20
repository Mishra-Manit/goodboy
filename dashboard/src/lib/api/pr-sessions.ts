/** PR review session endpoints (watchers + per-session runs). */

import { request } from "./client.js";
import type { PrSession, PrSessionWithRuns, LogEntry } from "./types.js";

export async function fetchPrSessions(): Promise<PrSession[]> {
  return request("/api/pr-sessions");
}

export async function fetchPrSessionDetail(id: string): Promise<PrSessionWithRuns> {
  return request(`/api/pr-sessions/${id}`);
}

export async function fetchPrSessionLogs(id: string): Promise<{ entries: LogEntry[] }> {
  return request(`/api/pr-sessions/${id}/logs`);
}
