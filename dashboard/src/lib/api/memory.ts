/** Memory run API helpers. */

import { request } from "./client.js";
import type { FileEntry, MemoryRun, MemoryRunKind } from "./types.js";

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
