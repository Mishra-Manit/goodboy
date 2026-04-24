/**
 * Deletes the current on-disk memory store for one repo: nested git worktree
 * first, then the parent memory directory.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../shared/logger.js";
import { memoryDir, memoryWorktreeDir } from "./index.js";

const exec = promisify(execFile);
const log = createLogger("memory-delete");

// --- Public API ---

export interface DeleteRepoMemoryResult {
  deletedWorktree: boolean;
  deletedMemoryDir: boolean;
  memoryDirPath: string;
  worktreePath: string;
}

/** Remove the repo's memory checkout plus its parent memory directory. */
export async function deleteRepoMemoryArtifacts(
  repo: string,
  repoPath: string,
): Promise<DeleteRepoMemoryResult> {
  const memoryPath = memoryDir(repo);
  const worktreePath = memoryWorktreeDir(repo);
  const hadWorktree = existsSync(worktreePath);
  const hadMemoryDir = existsSync(memoryPath);

  // First prune clears the main clone's worktree registry of stale entries,
  // so `git worktree remove` below succeeds even if the checkout dir was
  // deleted out-of-band. Second prune cleans up our own remove afterward.
  await pruneWorktrees(repoPath);

  if (hadWorktree) {
    await removeWorktree(repo, repoPath, worktreePath);
  }

  await pruneWorktrees(repoPath);
  await rm(memoryPath, { recursive: true, force: true });

  return {
    deletedWorktree: hadWorktree,
    deletedMemoryDir: hadMemoryDir,
    memoryDirPath: memoryPath,
    worktreePath,
  };
}

// --- Helpers ---

async function removeWorktree(repo: string, repoPath: string, worktreePath: string): Promise<void> {
  try {
    await exec("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
    return;
  } catch (err) {
    log.warn(`git worktree remove failed for ${repo}; falling back to rm + prune`, err);
  }

  await rm(worktreePath, { recursive: true, force: true });
}

async function pruneWorktrees(repoPath: string): Promise<void> {
  try {
    await exec("git", ["worktree", "prune"], { cwd: repoPath });
  } catch (err) {
    log.warn(`git worktree prune failed in ${repoPath}`, err);
  }
}
