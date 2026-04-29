/**
 * GitHub helpers: pure URL/identifier parsers and `gh` CLI wrappers for
 * reading PR comments and state. IO functions wrap the pure parsers so the
 * regex logic stays independently testable.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../shared/logger.js";
import type { PrComment, PrReviewState } from "../../shared/types.js";

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

/**
 * Run `gh` and parse stdout. Returns the fallback (defaults to `null`) on
 * any failure -- non-zero exit, JSON parse error, or transport error -- and
 * logs a warning. Centralizes the try/catch every PR fetcher used to repeat.
 */
async function ghJson<T>(
  args: readonly string[],
  warnLabel: string,
): Promise<T | null> {
  try {
    const { stdout } = await exec("gh", [...args]);
    return JSON.parse(stdout) as T;
  } catch (err) {
    log.warn(`${warnLabel}: ${String(err)}`);
    return null;
  }
}

/** Top-level issue comments on a PR. Returns `[]` on error (logged). */
export async function getPrComments(nwo: string, prNumber: number): Promise<PrComment[]> {
  const data = await ghJson<{
    comments: Array<{ id: string; author: { login: string }; body: string; createdAt: string }>;
  }>(
    ["pr", "view", String(prNumber), "--repo", nwo, "--json", "comments"],
    `Failed to fetch PR comments for ${nwo}#${prNumber}`,
  );
  return (data?.comments ?? []).map((c) => ({
    kind: "conversation",
    id: String(c.id),
    author: c.author.login,
    body: c.body,
    createdAt: c.createdAt,
  }));
}

/** Inline code-level review comments on a PR. Returns `[]` on error (logged). */
export async function getPrReviewComments(nwo: string, prNumber: number): Promise<PrComment[]> {
  const data = await ghJson<Array<{
    id: number; user: { login: string }; body: string;
    created_at: string; path?: string; line?: number;
  }>>(
    ["api", `/repos/${nwo}/pulls/${prNumber}/comments`, "--paginate"],
    `Failed to fetch review comments for ${nwo}#${prNumber}`,
  );
  return (data ?? []).map((c) => ({
    kind: "inline",
    id: String(c.id),
    author: c.user.login,
    body: c.body,
    createdAt: c.created_at,
    path: c.path ?? "",
    line: c.line ?? null,
  }));
}

/** Submitted PR reviews with non-empty top-level bodies. Returns `[]` on error (logged). */
export async function getPrReviews(nwo: string, prNumber: number): Promise<PrComment[]> {
  const data = await ghJson<Array<{
    id: number; user: { login: string } | null; body: string;
    state: string; submitted_at: string | null;
  }>>(
    ["api", `/repos/${nwo}/pulls/${prNumber}/reviews`, "--paginate"],
    `Failed to fetch PR reviews for ${nwo}#${prNumber}`,
  );
  return (data ?? [])
    .filter((r) => r.body.trim().length > 0 && r.user)
    .map((r) => ({
      kind: "review_summary",
      id: String(r.id),
      author: r.user!.login,
      body: r.body,
      createdAt: r.submitted_at ?? new Date().toISOString(),
      state: mapReviewState(r.state),
    }));
}

function mapReviewState(raw: string): PrReviewState {
  const upper = raw.toUpperCase();
  if (upper === "APPROVED") return "approved";
  if (upper === "CHANGES_REQUESTED") return "changes_requested";
  return "commented";
}

export interface PrMetadata {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
  author: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  changedFiles: readonly { path: string; additions: number; deletions: number }[];
}

/** Fetch PR metadata needed by the pr-review pipeline. Throws on gh failure. */
export async function getPrMetadata(nwo: string, prNumber: number): Promise<PrMetadata> {
  const { stdout } = await exec("gh", [
    "pr", "view", String(prNumber),
    "--repo", nwo,
    "--json", "number,title,body,labels,author,baseRefName,headRefName,headRefOid,files",
  ]);
  const data = JSON.parse(stdout) as {
    number: number;
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
    author: { login: string };
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
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
    headSha: data.headRefOid,
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
