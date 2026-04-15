import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../shared/logger.js";
import { config, loadEnv } from "../../shared/config.js";
import { spawnPiSession } from "../pi-rpc.js";
import { createPrWorktree } from "../worktree.js";
import { getRepo } from "../../shared/repos.js";
import * as queries from "../../db/queries.js";
import { prSessionPrompt, formatCommentsPrompt } from "./prompts.js";
import { notifyTelegram, withTimeout, type SendTelegram } from "../shared.js";
import type { PrComment } from "./github.js";

const exec = promisify(execFile);
const log = createLogger("pr-session");

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Derive the session file path from a PR session ID. */
function sessionFilePath(prSessionId: string): string {
  return path.join(config.prSessionsDir, `${prSessionId}.jsonl`);
}

/**
 * Start a new PR session after the dev-task reviewer completes.
 * Creates the PR and persists the session for future comment rounds.
 */
export async function startPrSession(options: {
  originTaskId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  artifactsDir: string;
  sendTelegram: SendTelegram;
  chatId: string;
}): Promise<void> {
  const {
    originTaskId, repo, branch, worktreePath,
    artifactsDir, sendTelegram, chatId,
  } = options;

  const prSession = await queries.createPrSession({
    repo,
    branch,
    worktreePath,
    originTaskId,
    telegramChatId: chatId,
  });

  const sessionPath = sessionFilePath(prSession.id);
  const planPath = path.join(artifactsDir, "plan.md");
  const summaryPath = path.join(artifactsDir, "implementation-summary.md");
  const reviewPath = path.join(artifactsDir, "review.md");

  const systemPrompt = prSessionPrompt({
    mode: "own",
    repo,
    branch,
    planPath,
    summaryPath,
    reviewPath,
  });

  const model = loadEnv().PI_MODEL_PR_CREATOR ?? loadEnv().PI_MODEL;

  log.info(`Starting PR session ${prSession.id} for task ${originTaskId}`);

  const session = spawnPiSession({
    id: `pr-session-${prSession.id.slice(0, 8)}`,
    cwd: worktreePath,
    systemPrompt,
    model,
    sessionPath,
  });

  session.sendPrompt(
    `Push the branch and create a PR. Read the artifact files for context on the PR description.`,
  );

  try {
    const result = await withTimeout(
      session.waitForCompletion(),
      SESSION_TIMEOUT_MS,
      "PR session (create)",
    );

    const prUrl = extractPrUrl(result.fullOutput);
    const prNumber = prUrl ? extractPrNumber(prUrl) : null;

    if (prNumber) {
      await queries.updatePrSession(prSession.id, { prNumber, lastPolledAt: new Date() });
      // Also update the originating task with the PR info
      await queries.updateTask(originTaskId, { prUrl, prNumber });
      await notifyTelegram(
        sendTelegram,
        chatId,
        `PR is up: ${prUrl}\nI will watch for comments.`,
      );
    } else {
      await queries.updatePrSession(prSession.id, { lastPolledAt: new Date() });
      await notifyTelegram(
        sendTelegram,
        chatId,
        "PR session finished, but I could not detect the PR URL from output. Check GitHub.",
      );
    }
  } catch (err) {
    log.error(`PR session create failed for task ${originTaskId}`, err);
    await notifyTelegram(
      sendTelegram,
      chatId,
      `PR session failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    session.kill();
  }
}

/**
 * Resume a PR session when new comments are detected by the poller.
 */
export async function resumePrSession(options: {
  prSessionId: string;
  comments: PrComment[];
  sendTelegram: SendTelegram;
}): Promise<void> {
  const { prSessionId, comments, sendTelegram } = options;

  const prSession = await queries.getPrSession(prSessionId);
  if (!prSession || !prSession.worktreePath) {
    log.error(`Cannot resume PR session ${prSessionId}: missing record or worktree`);
    return;
  }

  const chatId = prSession.telegramChatId;

  // Pull latest changes in case of manual pushes
  try {
    await exec("git", ["pull", "--rebase"], { cwd: prSession.worktreePath });
  } catch (err) {
    log.warn(`Git pull failed in worktree for PR session ${prSessionId}`, err);
  }

  const sessionPath = sessionFilePath(prSessionId);

  // Reconstruct system prompt -- derive mode from originTaskId
  const mode = prSession.originTaskId ? "own" : "review";
  const systemPrompt = prSessionPrompt({
    mode,
    repo: prSession.repo,
    branch: prSession.branch ?? "",
    prNumber: prSession.prNumber ?? undefined,
  });

  const model = loadEnv().PI_MODEL_REVISION ?? loadEnv().PI_MODEL;

  log.info(`Resuming PR session ${prSessionId} with ${comments.length} new comments`);

  const session = spawnPiSession({
    id: `pr-session-${prSessionId.slice(0, 8)}-resume`,
    cwd: prSession.worktreePath,
    systemPrompt,
    model,
    sessionPath,
  });

  session.sendPrompt(formatCommentsPrompt(comments));

  try {
    await withTimeout(
      session.waitForCompletion(),
      SESSION_TIMEOUT_MS,
      "PR session (resume)",
    );

    await queries.updatePrSession(prSessionId, { lastPolledAt: new Date() });

    if (chatId) {
      await notifyTelegram(
        sendTelegram,
        chatId,
        `Addressed ${comments.length} comment${comments.length === 1 ? "" : "s"} on PR #${prSession.prNumber}. Pushed changes.`,
      );
    }
  } catch (err) {
    log.error(`PR session resume failed for ${prSessionId}`, err);
    if (chatId) {
      await notifyTelegram(
        sendTelegram,
        chatId,
        `Failed to address comments on PR #${prSession.prNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } finally {
    session.kill();
  }
}

/**
 * Start a PR session to review an external PR (not one we created).
 */
export async function startExternalReview(options: {
  repo: string;
  prNumber: number;
  sendTelegram: SendTelegram;
  chatId: string;
  taskId: string;
}): Promise<void> {
  const { repo, prNumber, sendTelegram, chatId, taskId } = options;

  const repoConfig = getRepo(repo);
  if (!repoConfig) {
    throw new Error(`Repo '${repo}' not found in registry`);
  }

  // Create worktree checked out to PR head
  const worktreePath = await createPrWorktree(
    repoConfig.localPath,
    String(prNumber),
    taskId,
  );

  // Determine branch name from the worktree
  let branch = `pr-review-${prNumber}-${taskId.slice(0, 8)}`;
  try {
    const { stdout } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath,
    });
    branch = stdout.trim();
  } catch {
    // fall back to the constructed name
  }

  const prSession = await queries.createPrSession({
    repo,
    prNumber,
    branch,
    worktreePath,
    telegramChatId: chatId,
    // no originTaskId -- this is an external review
  });

  const sessionPath = sessionFilePath(prSession.id);
  const nwo = ghNwo(repoConfig.githubUrl ?? "");

  const systemPrompt = prSessionPrompt({
    mode: "review",
    repo: nwo || repo,
    branch,
    prNumber,
  });

  const model = loadEnv().PI_MODEL_REVIEWER ?? loadEnv().PI_MODEL;

  log.info(`Starting external review for PR #${prNumber} on ${repo}`);

  const session = spawnPiSession({
    id: `pr-session-${prSession.id.slice(0, 8)}-review`,
    cwd: worktreePath,
    systemPrompt,
    model,
    sessionPath,
  });

  session.sendPrompt(
    "Review this PR. Read the diff, understand the changes, and post your review.",
  );

  try {
    await withTimeout(
      session.waitForCompletion(),
      SESSION_TIMEOUT_MS,
      "PR session (external review)",
    );

    await queries.updatePrSession(prSession.id, { lastPolledAt: new Date() });
    await notifyTelegram(
      sendTelegram,
      chatId,
      `Review posted for PR #${prNumber}. I will watch for follow-up comments.`,
    );
  } catch (err) {
    log.error(`External review failed for PR #${prNumber} on ${repo}`, err);
    throw err;
  } finally {
    session.kill();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPrUrl(text: string): string | null {
  const matches = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1];
}

function extractPrNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Extract "owner/repo" from a GitHub URL. */
function ghNwo(githubUrl: string): string {
  const match = githubUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? "";
}
