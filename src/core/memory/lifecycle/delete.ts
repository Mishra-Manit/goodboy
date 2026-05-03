/**
 * Deletes the current on-disk memory store for one repo: nested git worktree
 * first, then the parent memory directory.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { removeWorktree, pruneWorktrees } from "../../git/worktree.js";
import { memoryDir, memoryWorktreeDir } from "../index.js";

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
  // deleted out-of-band. Second prune de-registers a normal remove; in the
  // fallback rm path, `removeWorktree` already prunes internally.
  await pruneWorktrees(repoPath);

  if (hadWorktree) {
    await removeWorktree(repoPath, worktreePath, { strict: true });
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

// No local git-worktree helpers here. Reuse `core/git/worktree.ts` so cleanup
// behavior stays consistent everywhere.
