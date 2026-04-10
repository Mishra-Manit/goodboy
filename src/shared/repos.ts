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

export function getRepo(name: string): Repo | null {
  const entry = loadEnv().REGISTERED_REPOS[name];
  if (!entry) return null;
  return { name, ...entry };
}
