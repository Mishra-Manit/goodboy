/**
 * GitHub helpers: pure URL/identifier parsers and `gh` CLI wrappers for
 * reading PR comments and state. IO functions wrap the pure parsers so the
 * regex logic stays independently testable.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../shared/logger.js";

// --- Pure parsers ---

/** Extract "owner/repo" from a GitHub URL. Accepts HTTPS and SSH, with or without `.git`. */
export function parseNwo(githubUrl: string): string | null {
  const match = githubUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

/** Extract the PR number from a full URL like `https://github.com/org/repo/pull/42`. */
export function parsePrNumberFromUrl(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a user-supplied PR identifier. Accepts a full URL, `#42`, or `42`. */
export function parsePrIdentifier(identifier: string): number | null {
  const fromUrl = parsePrNumberFromUrl(identifier);
  if (fromUrl !== null) return fromUrl;
  const numMatch = identifier.match(/#?(\d+)/);
  if (!numMatch) return null;
  const parsed = Number(numMatch[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

// --- gh CLI wrappers ---

const exec = promisify(execFile);
const log = createLogger("pr-session-gh");

export interface PrComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** File path; present only on inline review comments. */
  path?: string;
  /** Line number; present only on inline review comments. */
  line?: number;
}

/** Top-level issue comments on a PR. Returns `[]` on error (logged). */
export async function getPrComments(
  nwo: string,
  prNumber: number,
): Promise<PrComment[]> {
  try {
    const { stdout } = await exec("gh", [
      "pr", "view", String(prNumber),
      "--repo", nwo,
      "--json", "comments",
    ]);
    const data = JSON.parse(stdout) as {
      comments: Array<{
        id: string;
        author: { login: string };
        body: string;
        createdAt: string;
      }>;
    };
    return data.comments.map((c) => ({
      id: String(c.id),
      author: c.author.login,
      body: c.body,
      createdAt: c.createdAt,
    }));
  } catch (err) {
    log.warn(`Failed to fetch PR comments for ${nwo}#${prNumber}`, err);
    return [];
  }
}

/** Inline code-level review comments on a PR. Returns `[]` on error (logged). */
export async function getPrReviewComments(
  nwo: string,
  prNumber: number,
): Promise<PrComment[]> {
  try {
    const { stdout } = await exec("gh", [
      "api", `/repos/${nwo}/pulls/${prNumber}/comments`,
      "--paginate",
    ]);
    const data = JSON.parse(stdout) as Array<{
      id: number;
      user: { login: string };
      body: string;
      created_at: string;
      path?: string;
      line?: number;
    }>;
    return data.map((c) => ({
      id: String(c.id),
      author: c.user.login,
      body: c.body,
      createdAt: c.created_at,
      path: c.path,
      line: c.line ?? undefined,
    }));
  } catch (err) {
    log.warn(`Failed to fetch review comments for ${nwo}#${prNumber}`, err);
    return [];
  }
}

export interface PrMetadata {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
  author: string;
  baseRef: string;
  headRef: string;
  changedFiles: readonly { path: string; additions: number; deletions: number }[];
}

/** Fetch PR metadata needed by the pr-review pipeline. Throws on gh failure. */
export async function getPrMetadata(nwo: string, prNumber: number): Promise<PrMetadata> {
  const { stdout } = await exec("gh", [
    "pr", "view", String(prNumber),
    "--repo", nwo,
    "--json", "number,title,body,labels,author,baseRefName,headRefName,files",
  ]);
  const data = JSON.parse(stdout) as {
    number: number;
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
    author: { login: string };
    baseRefName: string;
    headRefName: string;
    files: Array<{ path: string; additions: number; deletions: number }>;
  };
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    labels: data.labels.map((l) => l.name),
    author: data.author.login,
    baseRef: data.baseRefName,
    headRef: data.headRefName,
    changedFiles: data.files.map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
    })),
  };
}

/** Unified diff for a PR. Throws on gh failure. */
export async function getPrDiff(nwo: string, prNumber: number): Promise<string> {
  const { stdout } = await exec("gh", ["pr", "diff", String(prNumber), "--repo", nwo]);
  return stdout;
}

/** True if the PR is merged or closed. Returns `false` on error (logged). */
export async function isPrClosed(
  nwo: string,
  prNumber: number,
): Promise<boolean> {
  try {
    const { stdout } = await exec("gh", [
      "pr", "view", String(prNumber),
      "--repo", nwo,
      "--json", "state",
    ]);
    const data = JSON.parse(stdout) as { state: string };
    return data.state !== "OPEN";
  } catch (err) {
    log.warn(`Failed to check PR state for ${nwo}#${prNumber}`, err);
    return false;
  }
}
