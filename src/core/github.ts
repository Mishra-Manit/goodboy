import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../shared/logger.js";

const exec = promisify(execFile);
const log = createLogger("pr-session-gh");

export interface PrComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** File path (only present on inline review comments) */
  path?: string;
  /** Line number (only present on inline review comments) */
  line?: number;
}

/**
 * Fetch top-level issue comments on a PR.
 * Uses: gh pr view --json comments
 */
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

/**
 * Fetch inline review comments on a PR (code-level feedback).
 * Uses: gh api /repos/{nwo}/pulls/{number}/comments
 */
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

/**
 * Check if a PR is merged or closed.
 */
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
