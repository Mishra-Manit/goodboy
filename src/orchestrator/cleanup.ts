import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import { config } from "../shared/config.js";
import { getRepo } from "../shared/repos.js";
import { removeWorktree } from "./worktree.js";
import * as queries from "../db/queries.js";
import { emit } from "../shared/events.js";

const exec = promisify(execFile);
const log = createLogger("cleanup");

/**
 * Extract "owner/repo" from a GitHub URL like
 * "https://github.com/Mishra-Manit/coliseum.git"
 */
function ghNwo(githubUrl: string): string | null {
  const match = githubUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

/** Close a GitHub PR and delete its remote branch via `gh`. */
async function closePr(nwo: string, prNumber: number): Promise<void> {
  try {
    await exec("gh", [
      "pr", "close", String(prNumber),
      "--repo", nwo,
      "--delete-branch",
    ]);
    log.info(`Closed PR #${prNumber} on ${nwo} and deleted remote branch`);
  } catch (err) {
    log.warn(`Failed to close PR #${prNumber} on ${nwo}: ${err}`);
  }
}

/** Delete a local git branch. Best-effort. */
async function deleteLocalBranch(repoPath: string, branch: string): Promise<void> {
  try {
    await exec("git", ["branch", "-D", branch], { cwd: repoPath });
    log.info(`Deleted local branch ${branch}`);
  } catch {
    // Branch may already be gone
  }
}

/**
 * Full dismiss: close PR on GitHub, remove worktree, delete branches, update DB.
 * Used when the user explicitly rejects a task's output.
 */
export async function dismissTask(taskId: string): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  if (task.status === "running" || task.status === "queued") {
    throw new Error(`Cannot dismiss a ${task.status} task — cancel it first`);
  }

  const repo = getRepo(task.repo);
  if (!repo) {
    log.warn(`Repo '${task.repo}' not in registry, skipping git cleanup`);
  }

  // Close PR on GitHub
  if (task.prNumber && repo?.githubUrl) {
    const nwo = ghNwo(repo.githubUrl);
    if (nwo) await closePr(nwo, task.prNumber);
  }

  // Remove worktree
  if (task.worktreePath && repo) {
    await removeWorktree(repo.localPath, task.worktreePath);
  }

  // Delete local branch
  if (task.branch && repo) {
    await deleteLocalBranch(repo.localPath, task.branch);
  }

  // Clean up any associated PR session
  const prSession = await queries.getPrSessionByOriginTask(taskId);
  if (prSession) {
    await cleanupPrSession(prSession.id);
  }

  // Update DB — clear all resource references
  await queries.updateTask(taskId, {
    status: "cancelled",
    prUrl: null,
    prNumber: null,
    worktreePath: null,
    branch: null,
  });

  emit({ type: "task_update", taskId, status: "cancelled" });
  log.info(`Dismissed task ${taskId}`);
}

/**
 * Cleanup disk resources only (worktree + local branch). Keeps PR metadata
 * intact for historical visibility. Used after a PR is merged or closed
 * externally.
 */
export async function cleanupTaskResources(taskId: string): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) return;

  const repo = getRepo(task.repo);
  if (!repo) return;

  if (task.worktreePath) {
    await removeWorktree(repo.localPath, task.worktreePath);
  }

  if (task.branch) {
    await deleteLocalBranch(repo.localPath, task.branch);
  }

  await queries.updateTask(taskId, {
    worktreePath: null,
    branch: null,
  });

  log.info(`Cleaned up resources for task ${taskId}`);
}

/**
 * Clean up a PR session: close DB record, remove worktree + branch,
 * optionally delete session file.
 */
export async function cleanupPrSession(prSessionId: string): Promise<void> {
  const session = await queries.getPrSession(prSessionId);
  if (!session) return;

  const repo = getRepo(session.repo);

  // Remove worktree
  if (session.worktreePath && repo) {
    await removeWorktree(repo.localPath, session.worktreePath);
  }

  // Delete local branch
  if (session.branch && repo) {
    await deleteLocalBranch(repo.localPath, session.branch);
  }

  // Remove session file (best-effort)
  const sessionFile = path.join(config.prSessionsDir, `${prSessionId}.jsonl`);
  try {
    await rm(sessionFile, { force: true });
  } catch {
    // may not exist
  }

  // Mark session as closed
  await queries.updatePrSession(prSessionId, {
    status: "closed",
    worktreePath: null,
    branch: null,
  });

  log.info(`Cleaned up PR session ${prSessionId}`);
}
