/**
 * Git worktree primitives: sync the main checkout, create task and PR-review
 * worktrees, remove them cleanly (with fallback for stale metadata), and
 * generate LLM-sluggified branch names. Every new worktree also gets subagent
 * assets staged into `.pi/` for project-scoped agents.
 */

import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../shared/runtime/logger.js";
import { z } from "zod";
import { LIGHT_MODEL, structuredOutput } from "../../shared/llm/index.js";
import { stageSubagentAssets } from "../subagents/index.js";
import { exec } from "./exec.js";
import { buildSlugPrompt, SLUG_SYSTEM_PROMPT } from "./prompts.js";

const log = createLogger("worktree");

const BRANCH_SLUG_MAX_LEN = 50;
const BRANCH_SLUG_RETRIES = 3;
const ROOT_AGENTS_PATH = "AGENTS.md";
const slugSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+){1,5}$/, "must be 2-6 lowercase kebab-case words"),
});

// --- Public API ---

export interface CodingWorktree {
  path: string;
  agentsSuggestion?: string;
}

/** Fetch origin and hard-reset main so new worktrees branch from up-to-date code. */
export async function syncRepo(repoPath: string): Promise<void> {
  log.info(`Syncing repo at ${repoPath}`);
  await exec("git", ["fetch", "origin"], { cwd: repoPath });
  await exec("git", ["checkout", "main"], { cwd: repoPath });
  await exec("git", ["reset", "--hard", "origin/main"], { cwd: repoPath });
}

/** Create a fresh worktree on a new branch for a coding task. Wipes any existing worktree/branch first. */
export async function createWorktree(repoPath: string, branch: string, taskId: string): Promise<CodingWorktree> {
  const dir = path.join(repoPath, "..", `goodboy-worktree-${taskId.slice(0, 8)}`);

  // Start clean so retries can't inherit partial commits from a failed run.
  await forceRemoveWorktree(repoPath, dir);
  await forceDeleteBranch(repoPath, branch);

  await exec("git", ["worktree", "add", "-b", branch, dir], { cwd: repoPath });
  log.info(`Created worktree at ${dir} on branch ${branch}`);
  await stageSubagentAssets(dir);
  const agentsSuggestion = await hideAgentsFileInWorktree(repoPath, dir);
  return { path: dir, agentsSuggestion };
}

/**
 * Create a worktree checked out to a PR's real head branch. Same-repo only
 * (v1): because the PR branch lives at `origin/<headRef>`, we fetch it into
 * an identically-named local branch and check that out -- a direct
 * `git push origin <headRef>` from the worktree Just Works.
 *
 * Handles the retry case: if headRef is already checked out in a stale coding
 * worktree, that worktree is force-removed first so the fetch doesn't fail.
 */
export async function createPrWorktree(repoPath: string, headRef: string, taskId: string): Promise<string> {
  const dir = path.join(repoPath, "..", `goodboy-pr-${taskId.slice(0, 8)}`);

  // Remove the PR review worktree we're about to recreate.
  await forceRemoveWorktree(repoPath, dir);

  // If headRef is checked out in any other worktree (e.g. a stale coding
  // worktree from the task that created this branch), remove it now.
  // Without this, `git fetch origin headRef:headRef` and `git branch -D`
  // both fail with "refusing to fetch into branch checked out at <path>".
  const staleDir = await findWorktreeForBranch(repoPath, headRef);
  if (staleDir) {
    log.info(`Branch ${headRef} still checked out at ${staleDir}; removing stale worktree`);
    await forceRemoveWorktree(repoPath, staleDir);
    await pruneWorktrees(repoPath);
  }

  await forceDeleteBranch(repoPath, headRef);
  await exec("git", ["fetch", "origin", `${headRef}:${headRef}`], { cwd: repoPath });
  await addPrWorktree(repoPath, headRef, dir);
  return dir;
}

/** Recreate a PR-session worktree without stealing a branch checked out elsewhere. */
export async function createPrSessionWorktree(repoPath: string, headRef: string, prSessionId: string): Promise<string> {
  const dir = path.join(repoPath, "..", `goodboy-pr-${prSessionId.slice(0, 8)}`);

  await forceRemoveWorktree(repoPath, dir);
  await pruneWorktrees(repoPath);
  await exec("git", ["fetch", "origin", `+${headRef}:${headRef}`], { cwd: repoPath });
  await addPrWorktree(repoPath, headRef, dir);
  return dir;
}

/** True when a stored worktree path still exists as a directory. */
export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    return (await stat(worktreePath)).isDirectory();
  } catch {
    return false;
  }
}

/** Remove a worktree. Falls back to `rm -rf` + `git worktree prune` if git no longer tracks it. */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opts?: { strict?: boolean },
): Promise<void> {
  try {
    await exec("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
    log.info(`Removed worktree at ${worktreePath}`);
    return;
  } catch (err) {
    if (isMissingWorktreeError(err)) {
      log.info(`Worktree ${worktreePath} already detached from git; removing directory directly`);
    } else {
      log.warn(`git worktree remove failed for ${worktreePath}, falling back to manual cleanup`, err);
    }
  }

  // Fallback: directory exists on disk but git no longer tracks it. Drop it
  // and prune stale worktree metadata so future operations don't trip on it.
  try {
    await rm(worktreePath, { recursive: true, force: true });
    log.info(`Removed worktree directory at ${worktreePath}`);
  } catch (err) {
    log.warn(`Failed to rm worktree directory at ${worktreePath}`, err);
    if (opts?.strict) throw err;
  }
  await pruneWorktrees(repoPath);
}

/** Best-effort `git worktree prune` for a repo. */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  try {
    await exec("git", ["worktree", "prune"], { cwd: repoPath });
  } catch (err) {
    log.warn(`git worktree prune failed in ${repoPath}`, err);
  }
}

/** Produce a `goodboy/<slug>-<taskId[:8]>` branch name. Retries the LLM up to 3 times on degenerate output. */
export async function generateBranchName(taskId: string, description: string): Promise<string> {
  for (let attempt = 1; attempt <= BRANCH_SLUG_RETRIES; attempt++) {
    try {
      const { slug } = await structuredOutput({
        system: SLUG_SYSTEM_PROMPT,
        prompt: buildSlugPrompt(description),
        schema: slugSchema,
        model: LIGHT_MODEL,
        temperature: attempt === 1 ? 0 : 0.5,
      });
      return `goodboy/${slug.slice(0, BRANCH_SLUG_MAX_LEN)}-${taskId.slice(0, 8)}`;
    } catch (err) {
      log.warn(`Branch slug attempt ${attempt} failed`, err);
    }
  }
  throw new Error(`Failed to generate a valid branch slug after ${BRANCH_SLUG_RETRIES} attempts`);
}

// --- Helpers ---

async function addPrWorktree(repoPath: string, headRef: string, dir: string): Promise<void> {
  await exec("git", ["worktree", "add", dir, headRef], { cwd: repoPath });
  log.info(`Created PR worktree at ${dir} on branch ${headRef}`);
  await stageSubagentAssets(dir);
}

/**
 * Parse `git worktree list --porcelain` and return the worktree path that has
 * `branch` checked out, or null if none.
 */
async function findWorktreeForBranch(repoPath: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
    // Each worktree block is separated by a blank line. Fields: worktree, HEAD, branch.
    const blocks = stdout.trim().split(/\n\n+/);
    for (const block of blocks) {
      const worktreeLine = block.match(/^worktree (.+)$/m);
      const branchLine = block.match(/^branch refs\/heads\/(.+)$/m);
      if (worktreeLine && branchLine && branchLine[1] === branch) {
        return worktreeLine[1];
      }
    }
  } catch (err) {
    log.warn(`git worktree list failed in ${repoPath}`, err);
  }
  return null;
}

async function forceRemoveWorktree(repoPath: string, dir: string): Promise<void> {
  try {
    await exec("git", ["worktree", "remove", "--force", dir], { cwd: repoPath });
    log.info(`Removed existing worktree at ${dir}`);
  } catch { /* may not exist */ }
}

async function forceDeleteBranch(repoPath: string, branch: string): Promise<void> {
  try {
    await exec("git", ["branch", "-D", branch], { cwd: repoPath });
    log.info(`Deleted existing branch ${branch}`);
  } catch { /* may not exist */ }
}

async function hideAgentsFileInWorktree(repoPath: string, worktreePath: string): Promise<string | undefined> {
  const sourcePath = path.join(repoPath, ROOT_AGENTS_PATH);
  let suggestion: string | undefined;

  try {
    suggestion = (await readFile(sourcePath, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }

  try {
    await exec("git", ["update-index", "--skip-worktree", "--", ROOT_AGENTS_PATH], { cwd: worktreePath });
    await rm(path.join(worktreePath, ROOT_AGENTS_PATH), { force: true });
    log.info(`Hidden ${ROOT_AGENTS_PATH} in coding worktree at ${worktreePath}`);
  } catch (err) {
    log.warn(`Failed to hide ${ROOT_AGENTS_PATH} in coding worktree at ${worktreePath}`, err);
  }

  return suggestion;
}

function isMissingWorktreeError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("is not a working tree");
}
