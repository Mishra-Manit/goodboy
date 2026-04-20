/** Registered repo listing. */

import { request } from "./client.js";
import type { Repo } from "./types.js";

export async function fetchRepos(): Promise<Repo[]> {
  return request("/api/repos");
}
