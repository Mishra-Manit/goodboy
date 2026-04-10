import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createLogger } from "../shared/logger.js";

const exec = promisify(execFile);
const log = createLogger("worktree");

export async function createWorktree(
  repoPath: string,
  branch: string,
  taskId: string
): Promise<string> {
  const worktreeDir = path.join(repoPath, "..", `goodboy-worktree-${taskId.slice(0, 8)}`);

  // Always start clean -- remove existing worktree and branch so retries
  // never inherit partial commits from a previous failed run.
  try {
    await exec("git", ["worktree", "remove", worktreeDir, "--force"], { cwd: repoPath });
    log.info(`Removed existing worktree at ${worktreeDir}`);
  } catch {
    // Ignore -- may not exist
  }

  try {
    await exec("git", ["branch", "-D", branch], { cwd: repoPath });
    log.info(`Deleted existing branch ${branch}`);
  } catch {
    // Ignore -- branch may not exist
  }

  // Create a new branch and worktree
  await exec("git", ["worktree", "add", "-b", branch, worktreeDir], { cwd: repoPath });

  log.info(`Created worktree at ${worktreeDir} on branch ${branch}`);
  return worktreeDir;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await exec("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoPath });
    log.info(`Removed worktree at ${worktreePath}`);
  } catch (err) {
    log.warn(`Failed to remove worktree at ${worktreePath}`, err);
  }
}

export function generateBranchName(taskId: string, description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
  return `goodboy/${slug}-${taskId.slice(0, 8)}`;
}
