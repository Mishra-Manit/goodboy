/**
 * Registered repo accessors. The repo registry is defined by the
 * `REGISTERED_REPOS` env var (Zod-validated in `config.ts`) and exposed here
 * as ergonomic read-only lookups.
 */

import { loadEnv } from "./config.js";
import { parseNwo } from "./git-urls.js";

export interface Repo {
  name: string;
  localPath: string;
  githubUrl?: string;
  envNotes?: string;
}

export interface RepoSummary {
  name: string;
  githubUrl?: string;
}

/** All registered repos. */
export function listRepos(): readonly Repo[] {
  return Object.entries(loadEnv().REGISTERED_REPOS).map(([name, entry]) => ({ name, ...entry }));
}

/** Public repo DTO for dashboard/API callers. Never exposes local filesystem paths. */
export function listRepoSummaries(): readonly RepoSummary[] {
  return listRepos().map((repo) => ({
    name: repo.name,
    ...(repo.githubUrl ? { githubUrl: repo.githubUrl } : {}),
  }));
}

/** Just the names, in registry order. Used for prompt context and validation. */
export function listRepoNames(): readonly string[] {
  return listRepos().map((r) => r.name);
}

/** Look up a repo by name. Returns `null` if not registered. */
export function getRepo(name: string): Repo | null {
  const entry = loadEnv().REGISTERED_REPOS[name];
  return entry ? { name, ...entry } : null;
}

/** "owner/repo" for a registered repo, or `null` if the repo has no GitHub URL. */
export function getRepoNwo(name: string): string | null {
  const repo = getRepo(name);
  return repo?.githubUrl ? parseNwo(repo.githubUrl) : null;
}

/** Build a GitHub PR URL for a registered repo + PR number, or `null` if unavailable. */
export function buildPrUrl(repoName: string, prNumber: number | null): string | null {
  if (!prNumber) return null;
  const nwo = getRepoNwo(repoName);
  return nwo ? `https://github.com/${nwo}/pull/${prNumber}` : null;
}
