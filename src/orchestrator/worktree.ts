import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import { complete } from "../shared/llm.js";

const exec = promisify(execFile);
const log = createLogger("worktree");

/** Fetch latest origin/main and hard-reset so worktrees branch from up-to-date code. */
export async function syncRepo(repoPath: string): Promise<void> {
  log.info(`Syncing repo at ${repoPath}`);
  await exec("git", ["fetch", "origin"], { cwd: repoPath });
  await exec("git", ["checkout", "main"], { cwd: repoPath });
  await exec("git", ["reset", "--hard", "origin/main"], { cwd: repoPath });
}

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

export async function generateBranchName(taskId: string, description: string): Promise<string> {
  const result = await complete(description, {
    system: "Output a short professional git branch slug (lowercase, hyphens, 3-5 words). Nothing else. Example: fix-auth-token-refresh",
    maxTokens: 30,
  });

  const slug = toSlug(result ?? "") || toSlug(description);
  return `goodboy/${slug}-${taskId.slice(0, 8)}`;
}

function toSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "task";
}
