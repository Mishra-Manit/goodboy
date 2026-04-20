/** Task-derived PR feed. Session endpoints live in `pr-sessions.ts`. */

import { request } from "./client.js";
import type { PR } from "./types.js";

export async function fetchPRs(): Promise<PR[]> {
  return request("/api/prs");
}
