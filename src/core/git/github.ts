/**
 * GitHub helpers: pure URL/identifier parsers and `gh` CLI wrappers for
 * reading PR comments and state. IO functions wrap the pure parsers so the
 * regex logic stays independently testable.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z, type ZodType } from "zod";
import { createLogger } from "../../shared/runtime/logger.js";
import { PR_DIFF_CONTEXT_LINES } from "../../shared/runtime/config.js";
import { parseNwo, parsePrIdentifier, parsePrNumberFromUrl } from "../../shared/domain/git-urls.js";
import type { PrComment, PrReviewState } from "../../shared/domain/types.js";

export { parseNwo, parsePrIdentifier, parsePrNumberFromUrl };

// --- gh CLI wrappers ---

const exec = promisify(execFile);
const log = createLogger("pr-session-gh");

const prCommentsResponseSchema = z.object({
  comments: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    author: z.object({ login: z.string() }),
    body: z.string(),
    createdAt: z.string(),
  })),
});

const prReviewCommentsResponseSchema = z.array(z.object({
  id: z.number(),
  user: z.object({ login: z.string() }),
  body: z.string(),
  created_at: z.string(),
  path: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
}));

const prReviewsResponseSchema = z.array(z.object({
  id: z.number(),
  user: z.object({ login: z.string() }).nullable(),
  body: z.string(),
  state: z.string(),
  submitted_at: z.string().nullable(),
}));

const prMetadataResponseSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.object({ name: z.string() })),
  author: z.object({ login: z.string() }),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  files: z.array(z.object({
    path: z.string(),
    additions: z.number(),
    deletions: z.number(),
  })),
});

const prStateResponseSchema = z.object({ state: z.string() });

type PrReviewResponse = z.infer<typeof prReviewsResponseSchema>[number];

/**
 * Run `gh` and parse stdout. Returns the fallback (defaults to `null`) on
 * any failure -- non-zero exit, JSON parse error, or transport error -- and
 * logs a warning. Centralizes the try/catch every PR fetcher used to repeat.
 */
async function ghJson<T>(
  args: readonly string[],
  warnLabel: string,
  schema: ZodType<T>,
): Promise<T | null> {
  try {
    const { stdout } = await exec("gh", [...args]);
    return schema.parse(JSON.parse(stdout));
  } catch (err) {
    log.warn(`${warnLabel}: ${String(err)}`);
    return null;
  }
}

/** Top-level issue comments on a PR. Returns `[]` on error (logged). */
export async function getPrComments(nwo: string, prNumber: number): Promise<PrComment[]> {
  const data = await ghJson(
    ["pr", "view", String(prNumber), "--repo", nwo, "--json", "comments"],
    `Failed to fetch PR comments for ${nwo}#${prNumber}`,
    prCommentsResponseSchema,
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
  const data = await ghJson(
    ["api", `/repos/${nwo}/pulls/${prNumber}/comments`, "--paginate"],
    `Failed to fetch review comments for ${nwo}#${prNumber}`,
    prReviewCommentsResponseSchema,
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
  const data = await ghJson(
    ["api", `/repos/${nwo}/pulls/${prNumber}/reviews`, "--paginate"],
    `Failed to fetch PR reviews for ${nwo}#${prNumber}`,
    prReviewsResponseSchema,
  );
  return (data ?? [])
    .filter(hasReviewBodyAndAuthor)
    .map((r) => ({
      kind: "review_summary",
      id: String(r.id),
      author: r.user.login,
      body: r.body,
      createdAt: r.submitted_at ?? new Date().toISOString(),
      state: mapReviewState(r.state),
    }));
}

function hasReviewBodyAndAuthor(
  review: PrReviewResponse,
): review is PrReviewResponse & { user: { login: string } } {
  return review.body.trim().length > 0 && review.user !== null;
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
  const data = prMetadataResponseSchema.parse(JSON.parse(stdout));
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

/**
 * Unified diff for a PR with extended context lines.
 * Runs `git diff` inside the existing PR worktree instead of `gh pr diff` so
 * we can control the number of surrounding context lines via --unified.
 */
export async function getPrDiff(worktreePath: string, baseRef: string): Promise<string> {
  const { stdout } = await exec("git", [
    "-C", worktreePath,
    "diff", `origin/${baseRef}...HEAD`,
    `--unified=${PR_DIFF_CONTEXT_LINES}`,
  ]);
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
    const data = prStateResponseSchema.parse(JSON.parse(stdout));
    return data.state !== "OPEN";
  } catch (err) {
    log.warn(`Failed to check PR state for ${nwo}#${prNumber}`, err);
    return false;
  }
}
