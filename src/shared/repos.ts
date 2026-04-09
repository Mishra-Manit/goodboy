import { getRegisteredRepos } from "./config.js";

export interface Repo {
  name: string;
  localPath: string;
  githubUrl?: string;
}

export function listRepos(): readonly Repo[] {
  const registered = getRegisteredRepos();
  return Object.entries(registered).map(([name, entry]) => ({
    name,
    localPath: entry.localPath,
    githubUrl: entry.githubUrl,
  }));
}

export function getRepo(name: string): Repo | null {
  const registered = getRegisteredRepos();
  const entry = registered[name];
  if (!entry) return null;
  return { name, localPath: entry.localPath, githubUrl: entry.githubUrl };
}
