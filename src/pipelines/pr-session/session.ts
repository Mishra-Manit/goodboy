/**
 * Long-lived PR session: owns a pull request from creation through every
 * comment-driven revision. `startPrSession` is invoked after the coding
 * reviewer stage; `resumePrSession` is driven by the poller; and
 * `startExternalReview` handles drive-by reviews of PRs we did not author.
 * All three share the same pi-session + persistent sessionfile machinery.
 */

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../shared/logger.js";
import { loadEnv } from "../../shared/config.js";
import { emit } from "../../shared/events.js";
import { spawnPiSession } from "../../core/pi/spawn.js";
import {
  ensureSessionDir,
  prSessionPath,
  readSessionFile,
} from "../../core/pi/session-file.js";
import { broadcastSessionFile } from "../../core/pi/session-broadcast.js";
import { createPrWorktree } from "../../core/git/worktree.js";
import { getRepo } from "../../shared/repos.js";
import * as queries from "../../db/repository.js";
import { prSessionPrompt, formatCommentsPrompt, prCreationPrompt, externalReviewPrompt } from "./prompts.js";
import { memoryBlock } from "../../shared/agent-prompts.js";
import { notifyTelegram, withTimeout, type SendTelegram } from "../../core/stage.js";
import type { Env } from "../../shared/config.js";
import { parseNwo, parsePrNumberFromUrl, getPrMetadata, type PrComment } from "../../core/git/github.js";
import { withPipelineSpan, bridgeSessionToOtel } from "../../observability/index.js";
import { trace } from "@opentelemetry/api";
import { Goodboy } from "../../observability/attributes.js";

const exec = promisify(execFile);
const log = createLogger("pr-session");

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// --- Lifecycle entry points ---

/** Called right after the reviewer stage. Creates the PR and persists the session for future rounds. */
export async function startPrSession(options: {
  originTaskId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  artifactsDir: string;
  sendTelegram: SendTelegram;
  chatId: string;
}): Promise<void> {
  const { originTaskId, repo, branch, worktreePath, artifactsDir, sendTelegram, chatId } = options;

  const prSession = await queries.createPrSession({
    repo, branch, worktreePath, originTaskId, telegramChatId: chatId,
  });
  await transferTaskGitOwnership(originTaskId, prSession.id);

  const run = await queries.createPrSessionRun({
    prSessionId: prSession.id,
    trigger: "pr_creation",
  });
  log.info(`Starting PR session ${prSession.id} for task ${originTaskId}`);

  try {
    await runSessionTurn({
      prSessionId: prSession.id,
      labelSuffix: "create",
      cwd: worktreePath,
      systemPrompt: prSessionPrompt({
        mode: "own", repo, branch,
        planPath: path.join(artifactsDir, "plan.md"),
        summaryPath: path.join(artifactsDir, "implementation-summary.md"),
        reviewPath: path.join(artifactsDir, "review.md"),
      }),
      model: modelFor("PI_MODEL_PR_CREATOR"),
      prompt: prCreationPrompt,
      run,
      timeoutLabel: "PR session (create)",
    });

    const prUrl = await extractPrUrlFromSession(prSession.id);
    const prNumber = prUrl ? parsePrNumberFromUrl(prUrl) : null;
    await queries.updatePrSession(prSession.id, {
      ...(prNumber ? { prNumber } : {}),
      lastPolledAt: new Date(),
    });

    if (prNumber && prUrl) {
      await queries.updateTask(originTaskId, { prUrl, prNumber });
      await notifyTelegram(sendTelegram, chatId, `PR is up: ${prUrl}\nI will watch for comments.`);
    } else {
      await notifyTelegram(sendTelegram, chatId, "PR session finished, but I could not detect the PR URL from output. Check GitHub.");
    }
  } catch (err) {
    log.error(`PR session create failed for task ${originTaskId}`, err);
    await notifyTelegram(sendTelegram, chatId, `PR session failed: ${errorMessage(err)}`);
  }
}

/** Resume a PR session to address new comments detected by the poller. */
export async function resumePrSession(options: {
  prSessionId: string;
  comments: PrComment[];
  sendTelegram: SendTelegram;
}): Promise<void> {
  const { prSessionId, comments, sendTelegram } = options;

  const prSession = await queries.getPrSession(prSessionId);
  if (!prSession?.worktreePath) {
    log.error(`Cannot resume PR session ${prSessionId}: missing record or worktree`);
    return;
  }

  const { worktreePath, repo, branch, prNumber, originTaskId, telegramChatId: chatId } = prSession;
  await pullLatest(worktreePath, prSessionId);

  const run = await queries.createPrSessionRun({ prSessionId, trigger: "comments", comments });
  log.info(`Resuming PR session ${prSessionId} with ${comments.length} new comments`);

  const pluralS = comments.length === 1 ? "" : "s";
  if (chatId) {
    await notifyTelegram(sendTelegram, chatId,
      `Found ${comments.length} new comment${pluralS} on PR #${prNumber}. Addressing now...`);
  }

  const memory = await memoryBlock(repo);

  try {
    await runSessionTurn({
      prSessionId,
      labelSuffix: "resume",
      cwd: worktreePath,
      systemPrompt: memory + prSessionPrompt({
        mode: originTaskId ? "own" : "review",
        repo,
        branch: branch ?? "",
        prNumber: prNumber ?? undefined,
      }),
      model: modelFor("PI_MODEL_REVISION"),
      prompt: formatCommentsPrompt(comments),
      run,
      timeoutLabel: "PR session (resume)",
    });

    await queries.updatePrSession(prSessionId, { lastPolledAt: new Date() });
    if (chatId) {
      await notifyTelegram(sendTelegram, chatId,
        `Addressed ${comments.length} comment${pluralS} on PR #${prNumber}. Pushed changes.`);
    }
  } catch (err) {
    log.error(`PR session resume failed for ${prSessionId}`, err);
    if (chatId) {
      await notifyTelegram(sendTelegram, chatId,
        `Failed to address comments on PR #${prNumber}: ${errorMessage(err)}`);
    }
  }
}

/** Review an external PR we did not author. Creates a worktree at the PR head and posts a review. */
export async function startExternalReview(options: {
  repo: string;
  prNumber: number;
  sendTelegram: SendTelegram;
  chatId: string;
  taskId: string;
}): Promise<void> {
  const { repo, prNumber, sendTelegram, chatId, taskId } = options;

  const repoConfig = getRepo(repo);
  if (!repoConfig) throw new Error(`Repo '${repo}' not found in registry`);

  const nwo = repoConfig.githubUrl ? parseNwo(repoConfig.githubUrl) : null;
  if (!nwo) throw new Error(`Repo '${repo}' is missing a githubUrl`);

  // Resolve the PR's real head branch so the worktree lands on origin/<headRef>
  // and pushes flow back without any refspec gymnastics.
  const { headRef } = await getPrMetadata(nwo, prNumber);
  const worktreePath = await createPrWorktree(repoConfig.localPath, headRef, taskId);
  const branch = await currentBranch(worktreePath) ?? headRef;

  const prSession = await queries.createPrSession({
    repo, prNumber, branch, worktreePath, telegramChatId: chatId,
    // no originTaskId -- this is an external review
  });

  const run = await queries.createPrSessionRun({ prSessionId: prSession.id, trigger: "external_review" });
  log.info(`Starting external review for PR #${prNumber} on ${repo}`);

  try {
    await runSessionTurn({
      prSessionId: prSession.id,
      labelSuffix: "review",
      cwd: worktreePath,
      systemPrompt: prSessionPrompt({ mode: "review", repo: nwo, branch, prNumber }),
      model: modelFor("PI_MODEL_REVIEWER"),
      prompt: externalReviewPrompt,
      run,
      timeoutLabel: "PR session (external review)",
    });

    await queries.updatePrSession(prSession.id, { lastPolledAt: new Date() });
    await notifyTelegram(sendTelegram, chatId,
      `Review posted for PR #${prNumber}. I will watch for follow-up comments.`);
  } catch (err) {
    log.error(`External review failed for PR #${prNumber} on ${repo}`, err);
    throw err;
  }
}

// --- Shared session shell ---

interface SessionTurn {
  prSessionId: string;
  labelSuffix: string;
  cwd: string;
  systemPrompt: string;
  model: string;
  prompt: string;
  run: { id: string };
  timeoutLabel: string;
}

/**
 * Run one pi session turn: spawn, send prompt, wait (bounded), update run
 * status, and emit running on/off. Failure marks the run failed and rethrows
 * so the caller can do case-specific notification.
 */
async function runSessionTurn(turn: SessionTurn): Promise<void> {
  // Each turn (create / resume / review) is its own root trace, linked to the
  // long-lived PR session via `goodboy.pr_session.id`.
  return withPipelineSpan(
    { taskId: turn.run.id, kind: "pr_session" },
    async (pipelineSpan) => {
      pipelineSpan.setAttribute(Goodboy.PrSessionId, turn.prSessionId);
      pipelineSpan.setAttribute(Goodboy.PrSessionRunId, turn.run.id);
      await runSessionTurnInner(turn);
    },
  );
}

async function runSessionTurnInner(turn: SessionTurn): Promise<void> {
  const { prSessionId, labelSuffix, cwd, systemPrompt, model, prompt, run, timeoutLabel } = turn;

  emit({ type: "pr_session_update", prSessionId, running: true });
  const filePath = prSessionPath(prSessionId);
  await ensureSessionDir(filePath);
  const stopBroadcast = broadcastSessionFile(filePath, { scope: "pr_session", prSessionId });

  // Bridge pi's JSONL to OTel, parented under the active pipeline span. Safe
  // because `runSessionTurn` always invokes this from inside withPipelineSpan.
  const activeSpan = trace.getActiveSpan();
  const stopBridge = activeSpan
    ? bridgeSessionToOtel({
        sessionPath: filePath,
        stageSpan: activeSpan,
        taskId: run.id,
        initialModel: model,
      })
    : () => {};

  const session = spawnPiSession({
    id: `pr-session-${prSessionId.slice(0, 8)}-${labelSuffix}`,
    cwd,
    systemPrompt,
    model,
    sessionPath: filePath,
  });
  session.sendPrompt(prompt);

  try {
    await withTimeout(session.waitForCompletion(), SESSION_TIMEOUT_MS, timeoutLabel);
    await queries.updatePrSessionRun(run.id, { status: "complete", completedAt: new Date() });
  } catch (err) {
    await queries.updatePrSessionRun(run.id, {
      status: "failed",
      error: errorMessage(err),
      completedAt: new Date(),
    });
    throw err;
  } finally {
    session.kill();
    await session.waitForExit();
    stopBridge();
    stopBroadcast();
    emit({ type: "pr_session_update", prSessionId, running: false });
  }
}

// --- Helpers ---

function modelFor(key: keyof Env): string {
  const env = loadEnv();
  return (env[key] as string | undefined) ?? env.PI_MODEL;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Move worktree/branch ownership from the originating task row to the PR session row. */
async function transferTaskGitOwnership(taskId: string, prSessionId: string): Promise<void> {
  try {
    await queries.updateTask(taskId, { worktreePath: null, branch: null });
  } catch (err) {
    await queries.updatePrSession(prSessionId, { status: "closed", worktreePath: null, branch: null });
    throw err;
  }
}

/** Rebase-pull in the worktree in case comments arrived alongside manual pushes. Best-effort. */
async function pullLatest(worktreePath: string, prSessionId: string): Promise<void> {
  try {
    await exec("git", ["pull", "--rebase"], { cwd: worktreePath });
  } catch (err) {
    log.warn(`Git pull failed in worktree for PR session ${prSessionId}`, err);
  }
}

/** Read the worktree's current branch name. Returns `null` on failure. */
async function currentBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Scan the PR session's own pi session file for a GitHub PR URL and return
 * the last one found. The agent may cite other PRs for context, so the last
 * match is treated as the one just created.
 */
async function extractPrUrlFromSession(prSessionId: string): Promise<string | null> {
  const entries = await readSessionFile(prSessionPath(prSessionId));
  const urls: string[] = [];
  const pattern = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type !== "text") continue;
      const matches = block.text.match(pattern);
      if (matches) urls.push(...matches);
    }
  }
  return urls[urls.length - 1] ?? null;
}
