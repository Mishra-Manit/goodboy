import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import { config } from "../shared/config.js";
import { complete } from "../shared/llm.js";

const exec = promisify(execFile);
const log = createLogger("worktree");

/**
 * Copy pi-assets/* into <worktreePath>/.pi/*, silently overwriting any
 * pre-existing .pi/ directory from the target repo. Worktree destruction
 * cleans this up naturally; no manual teardown needed.
 *
 * Destination is `<worktree>/.pi/` (not `.pi/agent/`) so that pi-subagents
 * discovers project-scoped agents at `<worktree>/.pi/agents/*.md`, which is
 * where its findNearestProjectAgentsDir helper looks.
 */
async function copyPiAssets(worktreePath: string): Promise<void> {
  try {
    await stat(config.piAssetsDir);
  } catch {
    log.warn(`pi-assets directory missing at ${config.piAssetsDir}; skipping copy`);
    return;
  }
  const dest = path.join(worktreePath, ".pi");
  await cp(config.piAssetsDir, dest, { recursive: true, force: true });
  log.info(`Copied pi-assets into ${dest}`);
}

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
  await copyPiAssets(worktreeDir);
  return worktreeDir;
}

/** Create a worktree checked out to a PR's head ref. */
export async function createPrWorktree(
  repoPath: string,
  prNumber: string,
  taskId: string,
): Promise<string> {
  const dir = path.join(repoPath, "..", `goodboy-pr-${taskId.slice(0, 8)}`);

  // Clean up any existing worktree
  try {
    await exec("git", ["worktree", "remove", dir, "--force"], { cwd: repoPath });
  } catch { /* may not exist */ }

  const localBranch = `pr-review-${prNumber}-${taskId.slice(0, 8)}`;
  try {
    await exec("git", ["branch", "-D", localBranch], { cwd: repoPath });
  } catch { /* may not exist */ }

  await exec("git", ["fetch", "origin", `pull/${prNumber}/head:${localBranch}`], { cwd: repoPath });
  await exec("git", ["worktree", "add", dir, localBranch], { cwd: repoPath });

  log.info(`Created PR worktree at ${dir} for PR #${prNumber}`);
  await copyPiAssets(dir);
  return dir;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  // Try the clean path first: let git remove the worktree and its metadata.
  try {
    await exec("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoPath });
    log.info(`Removed worktree at ${worktreePath}`);
    return;
  } catch (err) {
    log.warn(`git worktree remove failed for ${worktreePath}, falling back to manual cleanup`, err);
  }

  // Fallback: directory exists on disk but git no longer considers it a
  // registered worktree (e.g. metadata was pruned, repo was re-cloned, or a
  // previous cleanup partially succeeded). Remove the directory ourselves
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
