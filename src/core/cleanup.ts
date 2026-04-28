/**
 * Cleanup of git and GitHub resources: close PRs, remove worktrees, delete
 * local branches, and clear the corresponding DB references. Exposes three
 * entry points for the three real-world cases (full dismiss, post-merge
 * disk cleanup, PR session teardown).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import { config } from "../shared/config.js";
import { getRepo } from "../shared/repos.js";
import { removeWorktree } from "./git/worktree.js";
import { parseNwo } from "./git/github.js";
import * as queries from "../db/repository.js";
import { emit } from "../shared/events.js";

const exec = promisify(execFile);
const log = createLogger("cleanup");

// --- Entry points ---

/** Full teardown for a task the user has rejected. Closes the PR, wipes git state, marks cancelled. */
export async function dismissTask(taskId: string): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status === "running" || task.status === "queued") {
    throw new Error(`Cannot dismiss a ${task.status} task — cancel it first`);
  }

  const repo = getRepo(task.repo);
  if (!repo) log.warn(`Repo '${task.repo}' not in registry, skipping git cleanup`);

  // External-review tasks are not allowed to close the upstream PR or delete
  // its remote branch -- both belong to the PR author. Local cleanup only.
  if (task.kind !== "pr_review" && task.prNumber && repo?.githubUrl) {
    const nwo = parseNwo(repo.githubUrl);
    if (nwo) await closePr(nwo, task.prNumber);
  }

  // Prefer PR-session teardown when one exists; it owns the worktree now.
  const prSession = await queries.getPrSessionBySourceTask(taskId);
  if (prSession) {
    await cleanupPrSession(prSession.id);
  } else if (repo) {
    await cleanupGitResources(repo.localPath, task);
  }

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

/** Disk-only cleanup after a PR is merged or closed externally. Keeps PR metadata for history. */
export async function cleanupTaskResources(taskId: string): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) return;

  const repo = getRepo(task.repo);
  if (!repo) return;

  await cleanupGitResources(repo.localPath, task);
  await queries.updateTask(taskId, { worktreePath: null, branch: null });
  log.info(`Cleaned up resources for task ${taskId}`);
}

/** Close a PR session: mark closed, remove worktree + branch, delete the pi sessionfile. */
export async function cleanupPrSession(prSessionId: string): Promise<void> {
  const session = await queries.getPrSession(prSessionId);
  if (!session) return;

  const repo = getRepo(session.repo);
  if (repo) await cleanupGitResources(repo.localPath, session);

  await removeSessionFile(prSessionId);

  await queries.updatePrSession(prSessionId, {
    status: "closed",
    worktreePath: null,
    branch: null,
  });
  if (session.sourceTaskId) {
    await queries.updateTask(session.sourceTaskId, { worktreePath: null, branch: null });
  }
  log.info(`Cleaned up PR session ${prSessionId}`);
}

// --- Primitives ---

interface GitResources {
  worktreePath: string | null;
  branch: string | null;
}

async function cleanupGitResources(repoPath: string, resources: GitResources): Promise<void> {
  if (resources.worktreePath) await removeWorktree(repoPath, resources.worktreePath);
  if (resources.branch) await deleteLocalBranch(repoPath, resources.branch);
}

/** Close a PR via `gh` and delete its remote branch. Best-effort (logs and swallows). */
async function closePr(nwo: string, prNumber: number): Promise<void> {
  try {
    await exec("gh", ["pr", "close", String(prNumber), "--repo", nwo, "--delete-branch"]);
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
  } catch { /* already gone */ }
}

async function removeSessionFile(prSessionId: string): Promise<void> {
  const sessionFile = path.join(config.prSessionsDir, `${prSessionId}.jsonl`);
  try {
    await rm(sessionFile, { force: true });
  } catch { /* may not exist */ }
}
