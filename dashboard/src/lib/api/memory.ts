/** Memory run API helpers. */

import { request } from "./client.js";
import type { CodeReviewerFeedbackRule, FileEntry, MemoryRun, MemoryRunKind } from "./types.js";

export type FeedbackListStatus = "active" | "inactive" | "all";

export interface MemoryRunsQuery {
  repo?: string;
  kind?: MemoryRunKind;
  includeTests?: boolean;
  limit?: number;
}

export async function fetchMemoryRuns(query: MemoryRunsQuery = {}): Promise<MemoryRun[]> {
  const params = new URLSearchParams();

  if (query.repo) params.set("repo", query.repo);
  if (query.kind) params.set("kind", query.kind);
  if (query.includeTests === false) params.set("includeTests", "false");
  if (query.limit) params.set("limit", String(query.limit));

  const qs = params.toString();
  return request(`/api/memory/runs${qs ? `?${qs}` : ""}`);
}

export async function fetchMemoryRun(id: string): Promise<MemoryRun> {
  return request(`/api/memory/runs/${id}`);
}

export async function fetchMemoryRunSession(id: string): Promise<{ entries: FileEntry[] }> {
  return request(`/api/memory/runs/${id}/session`);
}

export async function deleteMemoryTests(): Promise<{
  deletedRows: number;
  deletedTranscriptDirs: number;
  deletedMemoryDirs: number;
}> {
  return request("/api/memory/tests", { method: "DELETE" });
}

export async function deleteMemoryRepo(repo: string): Promise<{
  repo: string;
  deletedWorktree: boolean;
  deletedMemoryDir: boolean;
  deactivatedRuns: number;
}> {
  return request(`/api/memory/repo/${encodeURIComponent(repo)}`, {
    method: "DELETE",
  });
}

export async function fetchReviewerFeedback(
  repo: string,
  status: FeedbackListStatus = "all",
): Promise<CodeReviewerFeedbackRule[]> {
  const params = new URLSearchParams({ status });
  return request(`/api/memory/feedback/${encodeURIComponent(repo)}?${params}`);
}

