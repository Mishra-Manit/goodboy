/**
 * Git worktree primitives: sync the main checkout, create task and PR-review
 * worktrees, remove them cleanly (with fallback for stale metadata), and
 * generate LLM-sluggified branch names. Every new worktree also gets subagent
 * assets staged into `.pi/` for project-scoped agents.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../shared/logger.js";
import { z } from "zod";
import { LIGHT_MODEL, structuredOutput } from "../../shared/llm.js";
import { stageSubagentAssets } from "../subagents/index.js";
import { SLUG_SYSTEM_PROMPT } from "./prompts.js";

const exec = promisify(execFile);
const log = createLogger("worktree");

const BRANCH_SLUG_MAX_LEN = 50;
const BRANCH_SLUG_RETRIES = 3;
const slugSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+){1,5}$/, "must be 2-6 lowercase kebab-case words"),
});

// --- Public API ---

/** Fetch origin and hard-reset main so new worktrees branch from up-to-date code. */
export async function syncRepo(repoPath: string): Promise<void> {
  log.info(`Syncing repo at ${repoPath}`);
  await exec("git", ["fetch", "origin"], { cwd: repoPath });
  await exec("git", ["checkout", "main"], { cwd: repoPath });
  await exec("git", ["reset", "--hard", "origin/main"], { cwd: repoPath });
}

/** Create a fresh worktree on a new branch for a coding task. Wipes any existing worktree/branch first. */
export async function createWorktree(repoPath: string, branch: string, taskId: string): Promise<string> {
  const dir = path.join(repoPath, "..", `goodboy-worktree-${taskId.slice(0, 8)}`);

  // Start clean so retries can't inherit partial commits from a failed run.
  await forceRemoveWorktree(repoPath, dir);
  await forceDeleteBranch(repoPath, branch);

  await exec("git", ["worktree", "add", "-b", branch, dir], { cwd: repoPath });
  log.info(`Created worktree at ${dir} on branch ${branch}`);
  await stageSubagentAssets(dir);
  return dir;
}

/** Create a worktree checked out to a PR's head ref. */
export async function createPrWorktree(repoPath: string, prNumber: string, taskId: string): Promise<string> {
  const dir = path.join(repoPath, "..", `goodboy-pr-${taskId.slice(0, 8)}`);
  const localBranch = `pr-review-${prNumber}-${taskId.slice(0, 8)}`;

  await forceRemoveWorktree(repoPath, dir);
  await forceDeleteBranch(repoPath, localBranch);

  await exec("git", ["fetch", "origin", `pull/${prNumber}/head:${localBranch}`], { cwd: repoPath });
  await exec("git", ["worktree", "add", dir, localBranch], { cwd: repoPath });
  log.info(`Created PR worktree at ${dir} for PR #${prNumber}`);
  await stageSubagentAssets(dir);
  return dir;
}

/** Remove a worktree. Falls back to `rm -rf` + `git worktree prune` if git no longer tracks it. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await exec("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoPath });
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
  }
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
        prompt: `Task: ${description.trim()}`,
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

async function forceRemoveWorktree(repoPath: string, dir: string): Promise<void> {
  try {
    await exec("git", ["worktree", "remove", dir, "--force"], { cwd: repoPath });
    log.info(`Removed existing worktree at ${dir}`);
  } catch { /* may not exist */ }
}

async function forceDeleteBranch(repoPath: string, branch: string): Promise<void> {
  try {
    await exec("git", ["branch", "-D", branch], { cwd: repoPath });
    log.info(`Deleted existing branch ${branch}`);
  } catch { /* may not exist */ }
}

function isMissingWorktreeError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("is not a working tree");
}
