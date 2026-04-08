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
    .slice(0, 40)
    .replace(/-$/, "");
  return `goodboy/${slug}-${taskId.slice(0, 8)}`;
}
