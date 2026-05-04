/** Registered repo listing + per-repo memory status. */

import { request } from "./client.js";
import type { RepoSummary, MemoryStatus } from "./types.js";

export async function fetchRepos(): Promise<RepoSummary[]> {
  return request("/api/repos");
}

export async function fetchMemoryStatus(repo: string): Promise<MemoryStatus> {
  return request(`/api/memory/status/${encodeURIComponent(repo)}`);
}
