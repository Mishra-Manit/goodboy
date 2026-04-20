import { loadEnv } from "./config.js";

export interface Repo {
  name: string;
  localPath: string;
  githubUrl?: string;
  envNotes?: string;
}

export function listRepos(): readonly Repo[] {
  return Object.entries(loadEnv().REGISTERED_REPOS).map(([name, entry]) => ({
    name,
    ...entry,
  }));
}

export function listRepoNames(): readonly string[] {
  return listRepos().map((r) => r.name);
}

export function getRepo(name: string): Repo | null {
  const entry = loadEnv().REGISTERED_REPOS[name];
  if (!entry) return null;
  return { name, ...entry };
}

/** Extract "owner/repo" from a registered repo's githubUrl. */
export function getRepoNwo(name: string): string | null {
  const repo = getRepo(name);
  if (!repo?.githubUrl) return null;
  const match = repo.githubUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

/** Build a GitHub PR URL for a registered repo + PR number, or null if unavailable. */
export function buildPrUrl(repoName: string, prNumber: number | null): string | null {
  if (!prNumber) return null;
  const nwo = getRepoNwo(repoName);
  if (!nwo) return null;
  return `https://github.com/${nwo}/pull/${prNumber}`;
}
